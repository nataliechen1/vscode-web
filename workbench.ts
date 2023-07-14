import { isStandalone } from 'vs/base/browser/browser';
import { CancellationToken } from 'vs/base/common/cancellation';
import { parse } from 'vs/base/common/marshalling';
import { Emitter } from 'vs/base/common/event';
import { Disposable, IDisposable } from 'vs/base/common/lifecycle';
import { Schemas } from 'vs/base/common/network';
import { isEqual } from 'vs/base/common/resources';
import { URI, UriComponents } from 'vs/base/common/uri';
import { request } from 'vs/base/parts/request/browser/request';
import product from 'vs/platform/product/common/product';
import { isFolderToOpen, isWorkspaceToOpen } from 'vs/platform/window/common/window';
import { create } from 'vs/workbench/workbench.web.main';
import { posix } from 'vs/base/common/path';
import { ltrim } from 'vs/base/common/strings';
import type { IWorkbenchConstructionOptions } from 'vs/workbench/browser/web.api';
import type { IWorkspace, IWorkspaceProvider } from 'vs/workbench/services/host/browser/browserHostService';
import type { IURLCallbackProvider } from 'vs/workbench/services/url/browser/urlService';
import type { ICredentialsProvider } from 'vs/platform/credentials/common/credentials';
import type { IUpdate, IUpdateProvider } from 'vs/workbench/services/update/browser/updateService';

declare const window: any;

interface ICredential {
        service: string;
        account: string;
        password: string;
}

class ConavUpdateProvider implements IUpdateProvider {

	async checkForUpdate(): Promise<IUpdate | null> {
		const currVersion = window.localStorage.getItem("conav.version");
		const result = await fetch("/version");
		const versionString = await result.text();
		if (versionString) {
			const version = versionString.split('=')[1];
			if (version != currVersion) {
				window.localStorage.setItem("conav.version", version);
				return {version: version};
			}
		}
		return null;
	}

}

class LocalStorageCredentialsProvider implements ICredentialsProvider {

        private static readonly CREDENTIALS_STORAGE_KEY = 'credentials.provider';

        private readonly authService: string | undefined;

        constructor() {
                let authSessionInfo: { readonly id: string; readonly accessToken: string; readonly providerId: string; readonly canSignOut?: boolean; readonly scopes: string[][] } | undefined;
                const authSessionElement = document.getElementById('vscode-workbench-auth-session');
                const authSessionElementAttribute = authSessionElement ? authSessionElement.getAttribute('data-settings') : undefined;
                if (authSessionElementAttribute) {
                        try {
                                authSessionInfo = JSON.parse(authSessionElementAttribute);
                        } catch (error) { /* Invalid session is passed. Ignore. */ }
                }

                if (authSessionInfo) {
                        // Settings Sync Entry
                        this.setPassword(`${product.urlProtocol}.login`, 'account', JSON.stringify(authSessionInfo));

                        // Auth extension Entry
                        this.authService = `${product.urlProtocol}-${authSessionInfo.providerId}.login`;
                        this.setPassword(this.authService, 'account', JSON.stringify(authSessionInfo.scopes.map(scopes => ({
                                id: authSessionInfo!.id,
                                scopes,
                                accessToken: authSessionInfo!.accessToken
                        }))));
                }
        }

        private _credentials: ICredential[] | undefined;
        private get credentials(): ICredential[] {
                if (!this._credentials) {
                        try {
                                const serializedCredentials = window.localStorage.getItem(LocalStorageCredentialsProvider.CREDENTIALS_STORAGE_KEY);
                                if (serializedCredentials) {
                                        this._credentials = JSON.parse(serializedCredentials);
                                }
                        } catch (error) {
                                // ignore
                        }

                        if (!Array.isArray(this._credentials)) {
                                this._credentials = [];
                        }
                }

                return this._credentials;
        }

        private save(): void {
                window.localStorage.setItem(LocalStorageCredentialsProvider.CREDENTIALS_STORAGE_KEY, JSON.stringify(this.credentials));
        }

        async getPassword(service: string, account: string): Promise<string | null> {
                return this.doGetPassword(service, account);
        }

        private async doGetPassword(service: string, account?: string): Promise<string | null> {
                for (const credential of this.credentials) {
                        if (credential.service === service) {
				/*if (typeof account !== 'string' || account === credential.account) {
                                        return credential.password;
				}*/
				return credential.password;
                        }
                }

                return null;
        }

	async setPassword(service: string, account: string, password: string): Promise<void> {
		var srv = 'code-oss.login';
		var t = 'account';
		this.doDeletePassword(srv, t);
		
		const value = JSON.parse(password);
		const sess = JSON.parse(value.content)[0];
		const pass = { id: sess.id, providerId: value.extensionId, accessToken: sess.accessToken, account: sess.account };

                this.credentials.push({ service: srv, account: t, password: JSON.stringify(pass) });

                this.save();

                try {
                        if (password && service === this.authService) {
                                const value = JSON.parse(password);
                                if (Array.isArray(value) && value.length === 0) {
                                        await this.logout(service);
                                }
                        }
                } catch (error) {
                        console.log(error);
                }
        }

        async deletePassword(service: string, account: string): Promise<boolean> {
                const result = await this.doDeletePassword(service, account);

                if (result && service === this.authService) {
                        try {
                                await this.logout(service);
                        } catch (error) {
                                console.log(error);
                        }
                }

                return result;
        }

        private async doDeletePassword(service: string, account: string): Promise<boolean> {
                let found = false;

                this._credentials = this.credentials.filter(credential => {
                        if (credential.service === service && credential.account === account) {
                                found = true;

                                return false;
                        }

                        return true;
                });

                if (found) {
                        this.save();
                }

                return found;
        }

        async findPassword(service: string): Promise<string | null> {
                return this.doGetPassword(service);
        }

        async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
                return this.credentials
                        .filter(credential => credential.service === service)
                        .map(({ account, password }) => ({ account, password }));
        }

        private async logout(service: string): Promise<void> {
                const queryValues: Map<string, string> = new Map();
                queryValues.set('logout', String(true));
                queryValues.set('service', service);

                await request({
                        url: doCreateUri('/auth/logout', queryValues).toString(true)
                }, CancellationToken.None);
        }

        async clear(): Promise<void> {
                window.localStorage.removeItem(LocalStorageCredentialsProvider.CREDENTIALS_STORAGE_KEY);
        }
}

class LocalStorageURLCallbackProvider extends Disposable implements IURLCallbackProvider {

	private static REQUEST_ID = 0;

	private static QUERY_KEYS: ('scheme' | 'authority' | 'path' | 'query' | 'fragment')[] = [
		'scheme',
		'authority',
		'path',
		'query',
		'fragment'
	];

	private readonly _onCallback = this._register(new Emitter<URI>());
	readonly onCallback = this._onCallback.event;

	private pendingCallbacks = new Set<number>();
	private lastTimeChecked = Date.now();
	private checkCallbacksTimeout: unknown | undefined = undefined;
	private onDidChangeLocalStorageDisposable: IDisposable | undefined;

	constructor(private readonly _callbackRoute: string) {
		super();
	}

	create(options: Partial<UriComponents> = {}): URI {
		const id = ++LocalStorageURLCallbackProvider.REQUEST_ID;
		const queryParams: string[] = [`vscode-reqid=${id}`];

		for (const key of LocalStorageURLCallbackProvider.QUERY_KEYS) {
			const value = options[key];

			if (value) {
				queryParams.push(`vscode-${key}=${encodeURIComponent(value)}`);
			}
		}

		const key = `vscode-web.url-callbacks[${id}]`;
		window.localStorage.removeItem(key);

		this.pendingCallbacks.add(id);
		this.startListening();

		return URI.parse(window.location.href).with({ path: this._callbackRoute, query: queryParams.join('&') });
	}

	private startListening(): void {
		if (this.onDidChangeLocalStorageDisposable) {
			return;
		}

		const fn = () => this.onDidChangeLocalStorage();
		window.addEventListener('storage', fn);
		this.onDidChangeLocalStorageDisposable = { dispose: () => window.removeEventListener('storage', fn) };
	}

	private stopListening(): void {
		this.onDidChangeLocalStorageDisposable?.dispose();
		this.onDidChangeLocalStorageDisposable = undefined;
	}

	// this fires every time local storage changes, but we
	// don't want to check more often than once a second
	private async onDidChangeLocalStorage(): Promise<void> {
		const ellapsed = Date.now() - this.lastTimeChecked;

		if (ellapsed > 1000) {
			this.checkCallbacks();
		} else if (this.checkCallbacksTimeout === undefined) {
			this.checkCallbacksTimeout = setTimeout(() => {
				this.checkCallbacksTimeout = undefined;
				this.checkCallbacks();
			}, 1000 - ellapsed);
		}
	}

	private checkCallbacks(): void {
		let pendingCallbacks: Set<number> | undefined;

		for (const id of this.pendingCallbacks) {
			const key = `vscode-web.url-callbacks[${id}]`;
			const result = window.localStorage.getItem(key);

			if (result !== null) {
				try {
					this._onCallback.fire(URI.revive(JSON.parse(result)));
				} catch (error) {
					console.error(error);
				}

				pendingCallbacks = pendingCallbacks ?? new Set(this.pendingCallbacks);
				pendingCallbacks.delete(id);
				window.localStorage.removeItem(key);
			}
		}

		if (pendingCallbacks) {
			this.pendingCallbacks = pendingCallbacks;

			if (this.pendingCallbacks.size === 0) {
				this.stopListening();
			}
		}

		this.lastTimeChecked = Date.now();
	}
}

class WorkspaceProvider implements IWorkspaceProvider {

	private static QUERY_PARAM_EMPTY_WINDOW = 'ew';
	private static QUERY_PARAM_FOLDER = 'folder';
	private static QUERY_PARAM_WORKSPACE = 'workspace';

	private static QUERY_PARAM_PAYLOAD = 'payload';

	static create(config: IWorkbenchConstructionOptions & { folderUri?: UriComponents; workspaceUri?: UriComponents }) {
		let foundWorkspace = false;
		let workspace: IWorkspace;
		let payload = Object.create(null);

		const query = new URL(document.location.href).searchParams;
		query.forEach((value, key) => {
			switch (key) {

				// Folder
				case WorkspaceProvider.QUERY_PARAM_FOLDER:
					if (config.remoteAuthority && value.startsWith(posix.sep)) {
						// when connected to a remote and having a value
						// that is a path (begins with a `/`), assume this
						// is a vscode-remote resource as simplified URL.
						workspace = { folderUri: URI.from({ scheme: Schemas.vscodeRemote, path: value, authority: config.remoteAuthority }) };
					} else {
						workspace = { folderUri: URI.parse(value) };
					}
					foundWorkspace = true;
					break;

				// Workspace
				case WorkspaceProvider.QUERY_PARAM_WORKSPACE:
					if (config.remoteAuthority && value.startsWith(posix.sep)) {
						// when connected to a remote and having a value
						// that is a path (begins with a `/`), assume this
						// is a vscode-remote resource as simplified URL.
						workspace = { workspaceUri: URI.from({ scheme: Schemas.vscodeRemote, path: value, authority: config.remoteAuthority }) };
					} else {
						workspace = { workspaceUri: URI.parse(value) };
					}
					foundWorkspace = true;
					break;

				// Empty
				case WorkspaceProvider.QUERY_PARAM_EMPTY_WINDOW:
					workspace = undefined;
					foundWorkspace = true;
					break;

				// Payload
				case WorkspaceProvider.QUERY_PARAM_PAYLOAD:
					try {
						payload = Object.entries(parse(value)); // use marshalling#parse() to revive potential URIs
					} catch (error) {
						console.error(error); // possible invalid JSON
					}
					break;
			}
		});

		// If no workspace is provided through the URL, check for config
		// attribute from server
		if (!foundWorkspace) {
			if (config.folderUri) {
				workspace = { folderUri: URI.revive(config.folderUri) };
			} else if (config.workspaceUri) {
				workspace = { workspaceUri: URI.revive(config.workspaceUri) };
			}
		}

		return new WorkspaceProvider(workspace, payload, config);
	}

	readonly trusted = true;

	private constructor(
		readonly workspace: IWorkspace,
		readonly payload: object,
		private readonly config: IWorkbenchConstructionOptions
	) {
	}

	async open(workspace: IWorkspace, options?: { reuse?: boolean; payload?: object }): Promise<boolean> {
		if (options?.reuse && !options.payload && this.isSame(this.workspace, workspace)) {
			return true; // return early if workspace and environment is not changing and we are reusing window
		}

		const targetHref = this.createTargetUrl(workspace, options);
		if (targetHref) {
			if (options?.reuse) {
				window.location.href = targetHref;
				return true;
			} else {
				let result;
				if (isStandalone()) {
					result = window.open(targetHref, '_blank', 'toolbar=no'); // ensures to open another 'standalone' window!
				} else {
					result = window.open(targetHref);
				}

				return !!result;
			}
		}
		return false;
	}

	private createTargetUrl(workspace: IWorkspace, options?: { reuse?: boolean; payload?: object }): string | undefined {

		// Empty
		let targetHref: string | undefined = undefined;
		if (!workspace) {
			targetHref = `${document.location.origin}${document.location.pathname}?${WorkspaceProvider.QUERY_PARAM_EMPTY_WINDOW}=true`;
		}

		// Folder
		else if (isFolderToOpen(workspace)) {
			let queryParamFolder: string;
			if (this.config.remoteAuthority && workspace.folderUri.scheme === Schemas.vscodeRemote) {
				// when connected to a remote and having a folder
				// for that remote, only use the path as query
				// value to form shorter, nicer URLs.
				// ensure paths are absolute (begin with `/`)
				// clipboard: ltrim(workspace.folderUri.path, posix.sep)
				queryParamFolder = `${posix.sep}${ltrim(workspace.folderUri.path, posix.sep)}`;
			} else {
				queryParamFolder = encodeURIComponent(workspace.folderUri.toString(true));
			}

			targetHref = `${document.location.origin}${document.location.pathname}?${WorkspaceProvider.QUERY_PARAM_FOLDER}=${queryParamFolder}`;
		}

		// Workspace
		else if (isWorkspaceToOpen(workspace)) {
			let queryParamWorkspace: string;
			if (this.config.remoteAuthority && workspace.workspaceUri.scheme === Schemas.vscodeRemote) {
				// when connected to a remote and having a workspace
				// for that remote, only use the path as query
				// value to form shorter, nicer URLs.
				// ensure paths are absolute (begin with `/`)
				queryParamWorkspace = `${posix.sep}${ltrim(workspace.workspaceUri.path, posix.sep)}`;
			} else {
				queryParamWorkspace = encodeURIComponent(workspace.workspaceUri.toString(true));
			}

			targetHref = `${document.location.origin}${document.location.pathname}?${WorkspaceProvider.QUERY_PARAM_WORKSPACE}=${queryParamWorkspace}`;
		}

		// Append payload if any
		if (options?.payload) {
			targetHref += `&${WorkspaceProvider.QUERY_PARAM_PAYLOAD}=${encodeURIComponent(JSON.stringify(options.payload))}`;
		}

		return targetHref;
	}

	private isSame(workspaceA: IWorkspace, workspaceB: IWorkspace): boolean {
		if (!workspaceA || !workspaceB) {
			return workspaceA === workspaceB; // both empty
		}

		if (isFolderToOpen(workspaceA) && isFolderToOpen(workspaceB)) {
			return isEqual(workspaceA.folderUri, workspaceB.folderUri); // same workspace
		}

		if (isWorkspaceToOpen(workspaceA) && isWorkspaceToOpen(workspaceB)) {
			return isEqual(workspaceA.workspaceUri, workspaceB.workspaceUri); // same workspace
		}

		return false;
	}

	hasRemote(): boolean {
		if (this.workspace) {
			if (isFolderToOpen(this.workspace)) {
				return this.workspace.folderUri.scheme === Schemas.vscodeRemote;
			}

			if (isWorkspaceToOpen(this.workspace)) {
				return this.workspace.workspaceUri.scheme === Schemas.vscodeRemote;
			}
		}

		return true;
	}
}

function doCreateUri(path: string, queryValues: Map<string, string>): URI {
        let query: string | undefined = undefined;

        if (queryValues) {
                let index = 0;
                queryValues.forEach((value, key) => {
                        if (!query) {
                                query = '';
                        }

                        const prefix = (index++ === 0) ? '' : '&';
                        query += `${prefix}${key}=${encodeURIComponent(value)}`;
                });
        }

        return URI.parse(window.location.href).with({ path, query });
}

(async function () {
  // create workbench
  let config: IWorkbenchConstructionOptions & {
    folderUri?: UriComponents;
    workspaceUri?: UriComponents;
    domElementId?: string;
    callbackRoute?: string;
  } = {};

  if (window.product) {
    config = window.product;
  } else {
    const result = await fetch("/product.json");
    config = await result.json();
  }

  if (Array.isArray(config.additionalBuiltinExtensions)) {
    const tempConfig = { ...config };

    tempConfig.additionalBuiltinExtensions =
      config.additionalBuiltinExtensions.map((ext) => URI.revive(ext));
    tempConfig.webviewEndpoint = location.origin + '/static/out/vs/workbench/contrib/webview/browser/pre/';
    config = tempConfig;

  }

  const workspaceProvider: IWorkspaceProvider = WorkspaceProvider.create(config);
  config = { ...config, workspaceProvider, updateProvider: new ConavUpdateProvider(), urlCallbackProvider: new LocalStorageURLCallbackProvider(config.callbackRoute || '/callback'), credentialsProvider: new LocalStorageCredentialsProvider()};

  const domElement = !!config.domElementId
    && document.getElementById(config.domElementId)
    || document.body;

  create(domElement, config);
})();
