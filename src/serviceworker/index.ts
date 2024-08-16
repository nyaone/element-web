/*
Copyright 2024 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { idbLoad } from "matrix-react-sdk/src/utils/StorageAccess";
import { ACCESS_TOKEN_IV, tryDecryptToken } from "matrix-react-sdk/src/utils/tokens/tokens";
import { buildAndEncodePickleKey } from "matrix-react-sdk/src/utils/tokens/pickling";

const serverSupportMap: {
    [serverUrl: string]: {
        supportsAuthedMedia: boolean;
        cacheExpiryTimeMs: number;
    };
} = {};

global.addEventListener("install", (event) => {
    // We skipWaiting() to update the service worker more frequently, particularly in development environments.
    // @ts-expect-error - service worker types are not available. See 'fetch' event handler.
    event.waitUntil(skipWaiting());
});

global.addEventListener("activate", (event) => {
    // We force all clients to be under our control, immediately. This could be old tabs.
    // @ts-expect-error - service worker types are not available. See 'fetch' event handler.
    event.waitUntil(clients.claim());
});

// @ts-expect-error - the service worker types conflict with the DOM types available through TypeScript. Many hours
// have been spent trying to convince the type system that there's no actual conflict, but it has yet to work. Instead
// of trying to make it do the thing, we force-cast to something close enough where we can (and ignore errors otherwise).
global.addEventListener("fetch", (event: FetchEvent) => {
    // This is the authenticated media (MSC3916) check, proxying what was unauthenticated to the authenticated variants.

    if (event.request.method !== "GET") {
        return; // not important to us
    }

    // Note: ideally we'd keep the request headers etc, but in practice we can't even see those details.
    // See https://stackoverflow.com/a/59152482
    let url = event.request.url;

    // We only intercept v3 download and thumbnail requests as presumably everything else is deliberate.
    // For example, `/_matrix/media/unstable` or `/_matrix/media/v3/preview_url` are something well within
    // the control of the application, and appear to be choices made at a higher level than us.
    if (!url.includes("/_matrix/media/v3/download") && !url.includes("/_matrix/media/v3/thumbnail")) {
        return; // not a URL we care about
    }

    // We need to call respondWith synchronously, otherwise we may never execute properly. This means
    // later on we need to proxy the request through if it turns out the server doesn't support authentication.
    event.respondWith(
        (async (): Promise<Response> => {
            let accessToken: string | undefined;
            try {
                // Figure out which homeserver we're communicating with
                const csApi = url.substring(0, url.indexOf("/_matrix/media/v3"));

                // Add jitter to reduce request spam, particularly to `/versions` on initial page load
                await new Promise<void>((resolve) => setTimeout(() => resolve(), Math.random() * 10));

                // Locate our access token, and populate the fetchConfig with the authentication header.
                // @ts-expect-error - service worker types are not available. See 'fetch' event handler.
                const client = await global.clients.get(event.clientId);
                accessToken = await getAccessToken(client);

                // Update or populate the server support map using a (usually) authenticated `/versions` call.
                await tryUpdateServerSupportMap(csApi, accessToken);

                // If we have server support (and a means of authentication), rewrite the URL to use MSC3916 endpoints.
                if (serverSupportMap[csApi].supportsAuthedMedia && accessToken) {
                    url = url.replace(/\/media\/v3\/(.*)\//, "/client/v1/media/$1/");
                } // else by default we make no changes
            } catch (err) {
                console.error("SW: Error in request rewrite.", err);
            }

            // Add authentication and send the request. We add authentication even if MSC3916 endpoints aren't
            // being used to ensure patches like this work:
            // https://github.com/matrix-org/synapse/commit/2390b66bf0ec3ff5ffb0c7333f3c9b239eeb92bb
            return fetch(url, fetchConfigForToken(accessToken));
        })(),
    );
});

async function tryUpdateServerSupportMap(clientApiUrl: string, accessToken?: string): Promise<void> {
    // only update if we don't know about it, or if the data is stale
    if (serverSupportMap[clientApiUrl]?.cacheExpiryTimeMs > new Date().getTime()) {
        return; // up to date
    }

    const config = fetchConfigForToken(accessToken);
    const versions = await (await fetch(`${clientApiUrl}/_matrix/client/versions`, config)).json();
    console.log(`[ServiceWorker] /versions response for '${clientApiUrl}': ${JSON.stringify(versions)}`);

    serverSupportMap[clientApiUrl] = {
        supportsAuthedMedia: Boolean(versions?.versions?.includes("v1.11")),
        cacheExpiryTimeMs: new Date().getTime() + 2 * 60 * 60 * 1000, // 2 hours from now
    };
    console.log(
        `[ServiceWorker] serverSupportMap update for '${clientApiUrl}': ${JSON.stringify(serverSupportMap[clientApiUrl])}`,
    );
}

// Ideally we'd use the `Client` interface for `client`, but since it's not available (see 'fetch' listener), we use
// unknown for now and force-cast it to something close enough later.
async function getAccessToken(client: unknown): Promise<string | undefined> {
    // Access tokens are encrypted at rest, so while we can grab the "access token", we'll need to do work to get the
    // real thing.
    const encryptedAccessToken = await idbLoad("account", "mx_access_token");

    // We need to extract a user ID and device ID from localstorage, which means calling WebPlatform for the
    // read operation. Service workers can't access localstorage.
    const { userId, deviceId } = await askClientForUserIdParams(client);

    // ... and this is why we need the user ID and device ID: they're index keys for the pickle key table.
    const pickleKeyData = await idbLoad("pickleKey", [userId, deviceId]);
    if (pickleKeyData && (!pickleKeyData.encrypted || !pickleKeyData.iv || !pickleKeyData.cryptoKey)) {
        console.error("SW: Invalid pickle key loaded - ignoring");
        return undefined;
    }

    // Finally, try decrypting the thing and return that. This may fail, but that's okay.
    try {
        const pickleKey = await buildAndEncodePickleKey(pickleKeyData, userId, deviceId);
        return tryDecryptToken(pickleKey, encryptedAccessToken, ACCESS_TOKEN_IV);
    } catch (e) {
        console.error("SW: Error decrypting access token.", e);
        return undefined;
    }
}

// Ideally we'd use the `Client` interface for `client`, but since it's not available (see 'fetch' listener), we use
// unknown for now and force-cast it to something close enough inside the function.
async function askClientForUserIdParams(client: unknown): Promise<{ userId: string; deviceId: string }> {
    return new Promise((resolve, reject) => {
        // Dev note: this uses postMessage, which is a highly insecure channel. postMessage is typically visible to other
        // tabs, windows, browser extensions, etc, making it far from ideal for sharing sensitive information. This is
        // why our service worker calculates/decrypts the access token manually: we don't want the user's access token
        // to be available to (potentially) malicious listeners. We do require some information for that decryption to
        // work though, and request that in the least sensitive way possible.
        //
        // We could also potentially use some version of TLS to encrypt postMessage, though that feels way more involved
        // than just reading IndexedDB ourselves.

        // Avoid stalling the tab in case something goes wrong.
        const timeoutId = setTimeout(() => reject(new Error("timeout in postMessage")), 1000);

        // We don't need particularly good randomness here - we just use this to generate a request ID, so we know
        // which postMessage reply is for our active request.
        const responseKey = Math.random().toString(36);

        // Add the listener first, just in case the tab is *really* fast.
        const listener = (event: MessageEvent): void => {
            if (event.data?.responseKey !== responseKey) return; // not for us
            clearTimeout(timeoutId); // do this as soon as possible, avoiding a race between resolve and reject.
            resolve(event.data); // "unblock" the remainder of the thread, if that were such a thing in JavaScript.
            global.removeEventListener("message", listener); // cleanup, since we're not going to do anything else.
        };
        global.addEventListener("message", listener);

        // Ask the tab for the information we need. This is handled by WebPlatform.
        (client as Window).postMessage({ responseKey, type: "userinfo" });
    });
}

function fetchConfigForToken(accessToken?: string): RequestInit | undefined {
    if (!accessToken) {
        return undefined; // no headers/config to specify
    }

    return {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
    };
}
