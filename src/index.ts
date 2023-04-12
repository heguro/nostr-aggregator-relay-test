import { readFile } from 'fs/promises';
import NostrTools from 'nostr-tools';
import configExample from './util/config.example.json';
import { getNowMsec, getNowSec } from './util/util';

type Config = typeof configExample;

let config: Config | null = null;

type NostrEvent = Omit<NostrTools.Event, 'kind'> & {
  kind: number;
};
type NostrUnsignedEvent = Omit<NostrTools.UnsignedEvent, 'kind'> & {
  kind: number;
};

type Connection = {
  url: string;
  relay: NostrTools.Relay | null;
  status: 'connected' | 'disconnected' | 'connecting' | 'failed';
  statusUpdateMsec: number;
};

let pubkeys: string[] = [];
const connections = new Map<string, Connection>();
let pubkeysUpdating = false;

const loadConfig = async () => {
  const config = await readFile('../conf/config.json', 'utf-8');
  return JSON.parse(config) as Config;
};

const loadPubkeys = async () => {
  if (!config) return;
  const localConnection = connections.get(config.localRelay);
  const relay = localConnection?.relay;
  if (!relay) return;
  const event = await relay.get({
    kinds: [30000],
    '#d': ['aggr-relay'],
    limit: 1,
  });
  if (event) {
    pubkeys = JSON.parse(event.content);
  }
};

const updatePubkeys = async () => {
  if (!config) return;
  pubkeysUpdating = false;
  const now = getNowSec();
  const pubkeysJson = JSON.stringify(pubkeys);
  const unsignedEvent: NostrUnsignedEvent = {
    kind: 30000,
    content: pubkeysJson,
    created_at: now,
    pubkey: NostrTools.getPublicKey(config.privateKeyHex),
    tags: [['d', 'aggr-relay']],
  };
  const id = NostrTools.serializeEvent(unsignedEvent);
  const sig = NostrTools.signEvent(unsignedEvent, config.privateKeyHex);
  const event = { ...unsignedEvent, id, sig };
  broadcastToLocalRelay(event);
};

const broadcastToLocalRelay = (event: NostrTools.Event) => {
  if (!config) return;
  const localConnection = connections.get(config.localRelay);
  const relay = localConnection?.relay;
  if (relay) {
    relay.publish(event);
  }
};

const relayConnect = async (relayUrl: string, retry?: boolean) => {
  if (!config) return;
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
  });
  relay.on('disconnect', () => {
    setTimeout(() => {
      relayConnect(relayUrl, true);
    }, 10000);
  });
  relay.on('error', () => {
    if (connection.status === 'connecting') {
      relay.close();
    }
  });
  const sub = relay.sub([{ kinds: [1], limit: 500 }]);
  sub.on('event', event => {
    if (pubkeys.includes(event.pubkey)) {
      broadcastToLocalRelay(event);
    } else if (
      /[あ-ん]/.test(event.content) &&
      !/https?:\/\//.test(event.content)
    ) {
      broadcastToLocalRelay(event);
      pubkeys.push(event.pubkey);
      if (!pubkeysUpdating) {
        setTimeout(updatePubkeys, 2000);
        pubkeysUpdating = true;
      }
    }
  });
};

const init = async () => {
  config = await loadConfig();
  await relayConnect(config.localRelay);
  for (const relayUrl of config.remoteRelays) {
    relayConnect(relayUrl);
  }
};

init();
