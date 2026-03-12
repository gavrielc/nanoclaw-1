import fs from 'fs';
import https from 'https';
import { logger } from './logger.js';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

if (proxyUrl) {
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  let ca: Buffer | undefined;
  if (caPath) { try { ca = fs.readFileSync(caPath); } catch { } }

  // Layer 1: https.globalAgent for node-fetch/Grammy/Baileys
  try {
    const mod = await (Function('return import("https-proxy-agent")')() as Promise<any>);
    https.globalAgent = new mod.HttpsProxyAgent(proxyUrl, ca ? { ca } : {});
    logger.info({ proxy: proxyUrl }, 'Global HTTPS proxy agent set (node-fetch layer)');
  } catch { }

  // Layer 2: undici global dispatcher for built-in fetch
  try {
    const mod = await (Function('return import("undici")')() as Promise<any>);
    const opts: any = { uri: proxyUrl };
    if (ca) opts.requestTls = { ca };
    mod.setGlobalDispatcher(new mod.ProxyAgent(opts));
    logger.info({ proxy: proxyUrl }, 'Global undici proxy dispatcher set (built-in fetch layer)');
  } catch { }
}
