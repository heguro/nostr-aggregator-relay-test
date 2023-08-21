import * as NostrTools from '@heguro/nostr-tools-ws';
import { readFile, writeFile } from 'fs/promises';
import configExample from './resources/config.example.json';
import { delay, getNowMsec, getNowSec, log, uniq } from './util/util';

type Config = typeof configExample;

let config: Config | null = null;

type NostrEvent = Omit<NostrTools.Event, 'kind'> & {
  kind: number;
};
type NostrUnsignedEvent = Omit<NostrTools.UnsignedEvent, 'kind'> & {
  kind: number;
};

const recentEventIds: string[] = []; // not used

type Connection = {
  url: string;
  relay: NostrTools.Relay | null;
  status: 'connected' | 'disconnected' | 'connecting' | 'failed';
  statusUpdateMsec: number;
};

let pubkeys: string[] = [];
let eventsToSendAfterPubkeysUpdate: NostrEvent[] = [];
let pubkeysNotSent: string[] = [];
let pubkeysSending: string[] = [];
const connections = new Map<string, Connection>();
let pubkeysUpdating = false;

const loadConfig = async () => {
  const config = await readFile(__dirname + '/../conf/config.json', 'utf-8');
  return JSON.parse(config) as Config;
};

const loadPubkeys = async () => {
  if (!config) return;
  const localConnection = connections.get(config.localRelay);
  const relay = localConnection?.relay;
  if (!relay) return;
  const event = (
    await relay.list(
      [
        {
          kinds: [30000],
          '#d': ['aggr-relay'],
          limit: 1,
        },
      ],
      { skipVerification: true, id: '_' },
    )
  ).at(0);
  if (event) {
    log('loaded pubkeys');
    pubkeys = uniq(Array.from(JSON.parse(event.content) as string[]).sort());
  } else {
    log('no pubkeys saved yet');
  }
};

const updatePubkeys = async () => {
  if (!config) return;
  const now = getNowSec();
  const pubkeysJson = JSON.stringify(pubkeys);
  pubkeysSending = pubkeysNotSent;
  pubkeysNotSent = [];
  const eventsToSend = eventsToSendAfterPubkeysUpdate;
  eventsToSendAfterPubkeysUpdate = [];
  log(`adding ${pubkeysSending.length} pubkeys`);

  // apply new pubkeys whitelist
  for (const nostreamConfFilePath of config.nostreamConfFilesPath) {
    const nostreamConf = await readFile(nostreamConfFilePath, 'utf-8');
    const spc = '        ';
    const updatedConf = nostreamConf.replace(
      / {8}# aggregator-relay-pubkeys-from\n[\s\S]*? {8}# aggregator-relay-pubkeys-to\n/,
      `${spc}# aggregator-relay-pubkeys-from\n${pubkeys
        .map(p => `${spc}"${p}",\n`)
        .join('')}${spc}# aggregator-relay-pubkeys-to\n`,
    );
    await writeFile(nostreamConfFilePath, updatedConf, 'utf-8');
  }

  // save new list to restore
  const unsignedEvent: NostrUnsignedEvent = {
    kind: 30000,
    content: pubkeysJson,
    created_at: now,
    pubkey: NostrTools.getPublicKey(config.privateKeyHex),
    tags: [['d', 'aggr-relay']],
  };
  const id = NostrTools.getEventHash(unsignedEvent);
  const sig = NostrTools.signEvent(unsignedEvent, config.privateKeyHex);
  const event = { ...unsignedEvent, id, sig };
  await broadcastToLocalRelay(event);

  // wait to apply (idk how long it takes to apply)
  delay(500);

  // start to send events
  for (const event of eventsToSend) {
    broadcastToLocalRelay(event);
  }
  log(`sending ${eventsToSend.length} events`);

  pubkeysSending = [];
  pubkeysUpdating = false;
};

const broadcastToLocalRelay = (event: NostrEvent) =>
  new Promise<void>(resolve => {
    if (!config) return;
    const localConnection = connections.get(config.localRelay);
    const relay = localConnection?.relay;
    if (relay) {
      const pub = relay.publish(event);
      const ok = () => {
        pub.off('ok', ok);
        pub.off('failed', ok);
        resolve();
      };
      pub.on('ok', ok);
      pub.on('failed', ok);
    } else {
      resolve();
    }
  });

const relayConnect = async (
  relayUrl: string,
  headers: { [key: string]: string },
  retry: boolean,
  isLocal: boolean,
) => {
  if (!config) return;
  if (retry) {
    log(`retrying ${relayUrl}`);
  }
  const oldConnection = connections.get(relayUrl);
  if (
    oldConnection?.status === 'connecting' ||
    oldConnection?.status === 'connected'
  ) {
    return;
  }
  const connection: Connection = {
    url: relayUrl,
    relay: null,
    status: 'connecting',
    statusUpdateMsec: getNowMsec(),
  };
  connections.set(relayUrl, connection);
  const relay = NostrTools.relayInit(relayUrl, {
    getTimeout: 15000,
    listTimeout: 15000,
    headers,
    logError: true,
  });
  relay.on('disconnect', () => {
    log(`disconnected from ${relayUrl}`);
    setTimeout(() => {
      relayConnect(relayUrl, headers, true, isLocal);
    }, 10000);
  });
  relay.on('error', () => {
    log(`error from ${relayUrl}`);
    if (connection.status === 'connecting') {
      relay.close();
    }
  });
  relay.on('notice', (msg: string) => {
    log(`notice from ${relayUrl}: ${msg}`);
  });
  try {
    await relay.connect();
  } catch {
    log(`failed to connect to ${relayUrl}`);
    relay.close();
    return;
  }
  const sub = relay.sub([{ kinds: [0, 1, 5, 6, 7], limit: 500 }], {
    skipVerification: true,
  });
  sub.on('event', (event: NostrEvent) => {
    if (!isLocal) {
      if (pubkeys.includes(event.pubkey)) {
        if (
          pubkeysNotSent.includes(event.pubkey) ||
          pubkeysSending.includes(event.pubkey)
        ) {
          eventsToSendAfterPubkeysUpdate.push(event);
        } else {
          broadcastToLocalRelay(event);
        }
      } else if (
        // japanese + no url + no tags (not reply, not mostr. ignores nonce)
        event.kind === 1 &&
        /[ぁ-ん]/.test(event.content) &&
        !/https?:\/\//.test(event.content) &&
        !event.tags.filter(t => t[0] !== 'nonce').length &&
        NostrTools.verifySignature(event)
      ) {
        pubkeys.push(event.pubkey);
        pubkeys = pubkeys.sort();
        pubkeysNotSent.push(event.pubkey);
        eventsToSendAfterPubkeysUpdate.push(event);
        if (!pubkeysUpdating) {
          setTimeout(updatePubkeys, 1000);
          pubkeysUpdating = true;
        }
      }
    }
  });
  if (retry) {
    log(`reconnected to ${relayUrl}`);
  } else {
    log(`connected to ${relayUrl}`);
  }
  connection.status = 'connected';
  connection.relay = relay;
};

const init = async () => {
  config = await loadConfig();
  await relayConnect(config.localRelay, config.localRelayHeaders, false, true);
  log('local relay connected');

  await loadPubkeys();
  log(`pubkeys loaded: ${pubkeys.length}`);

  if (!pubkeys.includes(NostrTools.getPublicKey(config.privateKeyHex))) {
    pubkeys.push(NostrTools.getPublicKey(config.privateKeyHex));
    await updatePubkeys();
    await delay(500);
  }

  for (const relayUrl of config.remoteRelays) {
    relayConnect(
      relayUrl,
      { 'User-Agent': config.remoteRelaysUserAgent },
      false,
      false,
    );
  }
  log('connecting to relays');
};

init();
