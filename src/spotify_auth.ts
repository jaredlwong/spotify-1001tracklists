import SpotifyWebApi from 'spotify-web-api-node';
import express from 'express';
import path from 'path';
import http from 'http';
import { Page } from 'puppeteer';

export const SPOTIFY_SCOPES = [
  'ugc-image-upload',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'app-remote-control',
  'streaming',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-follow-modify',
  'user-follow-read',
  'user-read-playback-position',
  'user-top-read',
  'user-read-recently-played',
  'user-library-modify',
  'user-library-read',
  'user-read-email',
  'user-read-private',
] as const;

type SpotifyScope = typeof SPOTIFY_SCOPES[number];

function getServerUrl(server: http.Server, route?: string): string {
  const address = server.address();

  if (typeof address === 'string') {
    const url = new URL(`file://${address}`);
    return route === undefined ? url.href : new URL(route, url).href;
  } else if (address !== null && typeof address === 'object') {
    const { address: addr, port } = address;
    const baseUrl = `http://[${addr}]:${port}`;
    return route === undefined ? baseUrl : new URL(route, baseUrl).href;
  } else {
    throw new Error('Unable to get server URL');
  }
}

export async function getSpotifyClient(page: Page, options: {
  clientId: string,
  clientSecret: string,
  username: string,
  password: string,
  scopes?: SpotifyScope[],
  state?: string,
  showDialog?: boolean,
}): Promise<SpotifyWebApi> {
  const scopes = options.scopes ?? SPOTIFY_SCOPES;
  const state = options.state ?? 'some-state-of-my-choice';
  const showDialog = options.showDialog ?? false;

  const spotifyApi = new SpotifyWebApi({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: 'http://[::]:49494/callback',
    // redirectUri: callbackUri,
  });
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, state, showDialog);

  const code = await getAuthCode(page, authorizeURL, options.username, options.password);

  // Retrieve an access token and a refresh token
  const data = await spotifyApi.authorizationCodeGrant(code);

  // Set the access token on the API object to use it in later calls
  spotifyApi.setAccessToken(data.body['access_token']);
  spotifyApi.setRefreshToken(data.body['refresh_token']);
  return spotifyApi;
}

async function getAuthCode(page: Page, authorizeURL: string, username: string, password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const app = express();
    app.get('/callback', (req, res) => {
      res.sendFile(path.join(__dirname, 'callback.html'));
      try {
        if (req.query.error) {
          console.error(`Something went wrong. Error: ${req.query.error}`)
          reject(req.query.error);
        }
        if (!('code' in req.query)) {
          reject('No code found');
        }
        const code = req.query.code
        if (code) {
          resolve(code as string);
        } else {
          reject('No token found');
        }
      } finally {
        server.close();
      }
    });
  
    // Start the app
    const server = app.listen(49494, () => {
      // const callbackUri = getServerUrl(server, '/callback')
      loginToSpotify(page, authorizeURL, username, password).catch((err) => {
        console.error(`Error logging in: ${err}`);
        reject(err);
      });
    });
  });
}

async function loginToSpotify(page: Page, authorizationUrl: string, username: string, password: string) {
  await page.goto(authorizationUrl);
  if (page.url().includes('login')) {
    await page.type("#login-username", username);
    await page.type("#login-password", password);
    await page.click("#login-button");
  }
  if (page.url().includes('authorize')) {
    await page.waitForSelector('[data-testid="auth-accept"]');
    await page.click('[data-testid="auth-accept"]');
  }
}