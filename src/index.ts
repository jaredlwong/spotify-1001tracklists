import puppeteer from 'puppeteer-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { executablePath, Page } from 'puppeteer';
import { Command } from 'commander';
import axios from 'axios';
import * as spot from './spotify_auth';
import * as childProcess from 'child_process';


process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled promise rejection:', promise);
  console.error(reason);
});

async function time<T>(message: string, promise: Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await promise;
    const elapsed = Date.now() - start;
    console.info(`${message} completed in ${elapsed}ms`);
    return result;
  } catch (error) {
    const elapsed = Date.now() - start;
    console.info(`${message} failed in ${elapsed}ms`);
    throw error;
  }
}

function spawn(command: string, args: string[], options: object): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const result = childProcess.spawnSync(command, args, options);
    if (result.error) {
      reject(result.error);
    } else {
      resolve({ stdout: result.stdout.toString(), stderr: result.stderr.toString() });
    }
  });
}

async function getCredentials(itemName: string): Promise<{username: string, password: string}> {
  // Use the 1Password command-line tool to fetch the item with the given name
  // Install 1password-cli version 2+, ensure to enable Connect with 1Password CLI in 1Password settings
  const result = await spawn(
    'op',
    ['item', 'get', itemName, '--no-color', '--fields', 'label=username,label=password'],
    { encoding: 'utf8' }
  );

  // Parse the output of the command-line tool to extract the username and password
  const output = result.stdout.trim().split(',');
  if (output.length !== 2) {
    throw new Error(`Could not find username and password for item "${itemName}"`);
  }
  return {username: output[0], password: output[1]};
}

async function getSecret(itemName: string, label: string): Promise<string> {
  const result = await spawn(
    'op',
    ['item', 'get', itemName, '--no-color', '--fields', `label=${label}`],
    { encoding: 'utf8' }
  );
  return result.stdout.trim();
}

async function scrape(url: string) {
  const browser = await puppeteer.use(StealthPlugin())
    .launch({
      headless: false,
      executablePath: '/opt/homebrew/bin/chromium',
    });
  const page = await browser.newPage();
  console.log(`Navigating to ${url}`)
  await page.goto(url);
  const title = await page.title();
  console.log(`Finished navigating to ${url} (${title})`)
  const trackIds = await page.evaluate((): { title: string | undefined, trackId: string }[] => {
    function findMusicRecording(element: Element): HTMLElement | null {
      // Search the element itself for the attribute `itemtype="http://schema.org/MusicRecording"`
      // const musicRecordingElements = element.querySelectorAll('[itemtype="http://schema.org/MusicRecording"]');
      const musicRecordingElements = element.querySelectorAll('.trackValue');
      if (musicRecordingElements.length == 1) {
        return musicRecordingElements[0] as HTMLElement;
      }
      if (musicRecordingElements.length > 1) {
        return null;
      }
      if (!element.parentElement) {
        return null;
      }
      return findMusicRecording(element.parentElement);
    }

    try {
      const elements = document.querySelectorAll('.fa-spotify');
      const trackIds: { title : string | undefined, trackId: string }[] = [];
      for (const e of elements) {
        const span = e.closest('span');
        const onclick = span?.getAttribute('onclick');
        if (onclick !== null && onclick !== undefined) {
          const number = onclick.match(/\d+/);
          if (number !== null && number !== undefined && number.length > 0) {
            const musicRecord = findMusicRecording(e);
            
            trackIds.push({
              title: musicRecord?.innerText?.trim(),
              trackId: number[0],
            });
          }
        }
      }
      return trackIds;
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
    }
    return [];
  });

  console.log(`Finding spotify links for ${trackIds.length} tracks`);

  const promises: Promise<{
    spotify?: any;
    title: string | undefined;
    trackId: string;
  }>[] = [];
  const spotifyRegex = /https:\/\/open\.spotify\.com\/embed\/track\/(\w+)/;
  for (const track of trackIds) {
    const resp = axios.get(`https://www.1001tracklists.com/ajax/get_medialink.php?idObject=5&idItem=${track.trackId}`).then((resp) => {
      if (!('data' in resp.data)) {
        return track;
      }
      for (const players of resp.data.data) {
        const match = players.player.match(spotifyRegex);
        if (match !== null && match !== undefined && match.length == 2) {
          return {
            ...track,
            spotify: match[1],
          }
        }
      }
      return track;
    });
    promises.push(resp);
  }
  const response = await time('looking up spotify track ids', Promise.all(promises));
  console.log(`Found ${response.filter((r) => r.spotify !== undefined).length} spotify links`)
  await createSpotifyPlaylist(page, title, response);
  browser.close();
}

async function createSpotifyPlaylist(page: Page, name: string, tracks: { spotify?: any; title: string | undefined; trackId: string; }[]): Promise<void> {
  const clientId = await getSecret('spotify', 'app-client-id');
  const clientSecret = await getSecret('spotify', 'app-client-secret');
  const { username, password } = await getCredentials('spotify')
  console.log(`Creating spotify client for ${username}...`);
  const spotifyApi = await time(`Logged in to spotify as ${username}...`,
                                spot.getSpotifyClient(page, { clientId, clientSecret, username, password, showDialog: true }));

  const playlist = await spotifyApi.createPlaylist(name, { public: true })
  console.log(`Creating spotify playlist ${name}... ${playlist.body.uri}`)

  const tracksFiltered = tracks.filter((t) => t.spotify !== undefined);
  const trackIds = []
  for (let i = 0; i < tracksFiltered.length; i++) {
    const { spotify, title } = tracksFiltered[i];
    console.log(`[${i + 1}/${tracksFiltered.length}] ${title}`)
    trackIds.push(`spotify:track:${spotify}`)
  }

  for (let i = 0; i < trackIds.length; i += 100) {
    const chunk = trackIds.slice(i, i + 100);
    await spotifyApi.addTracksToPlaylist(playlist.body.id, chunk)
  }
}

interface Response<T> {
  body: T;
  headers: Record<string, string>;
  statusCode: number;
}

interface PagingObject<T> {
  href: string;
  items: T[];
  limit: number;
  next: string | null;
  offset: number;
  previous: string | null;
  total: number;
}

interface LimitOptions {
  limit?: number | undefined;
}

interface PaginationOptions extends LimitOptions {
  offset?: number | undefined;
}

async function getAllItems<T>(
  endpoint: (options: PaginationOptions) => Promise<Response<PagingObject<T>>>,
  limit: number = 50
): Promise<T[]> {
  const items = [];
  let offset = 0;

  while (true) {
    const chunk = await endpoint({ limit, offset });
    items.push(...chunk.body.items);
    if (chunk.body.next === null) {
      break;
    }
    offset = chunk.body.offset + limit;
  }

  return items;
}

async function spotify_command() {
  const browser = await puppeteer.use(StealthPlugin())
    .launch({
      headless: false,
      executablePath: '/opt/homebrew/bin/chromium',
    });
  const page = await browser.newPage();
  const clientId = await getSecret('spotify', 'app-client-id');
  const clientSecret = await getSecret('spotify', 'app-client-secret');
  const { username, password } = await getCredentials('spotify')
  const spotifyApi = await spot.getSpotifyClient(page, { clientId, clientSecret, username, password, showDialog: true })

  // spotifyApi.createPlaylist('My playlist', { 'description': 'My description', 'public': true })

  // const playlists = await getAllItems((options) => spotifyApi.getUserPlaylists(username, options));
  // for (const p of playlists) {
  //   console.log(`[${p.name}] ${p.uri}`)
  // }
}

async function main() {
  const program = new Command();
  program
    .command('scrape')
    .description('scrape 1001tracklists')
    .arguments('<url>')
    .action(async (url, options) => {
      try {
        await scrape(url);
        // await spot();
      } catch (err: any) {
        console.error(`Error: ${err.message}`)
      }
    });
  
  await program.parseAsync(process.argv);
}
  
void main();