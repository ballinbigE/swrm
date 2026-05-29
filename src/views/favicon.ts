import * as http from 'node:http';

// Branded swrm favicon — a honey hexagon (hive cell) with a bright focal dot on
// charcoal, matching the bee-swarm brand + native app palette (#15130F / #F5A623
// / #FFC24B). Served at both /favicon.svg and /favicon.ico so every page picks it
// up with no per-view <head> edit: browsers auto-request /favicon.ico, and modern
// engines render an SVG returned there when the content type is image/svg+xml.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#15130F"/>
  <path d="M16 4.5l9.1 5.25v10.5L16 25.5l-9.1-5.25V9.75z" fill="none" stroke="#F5A623" stroke-width="2.4" stroke-linejoin="round"/>
  <circle cx="16" cy="16" r="3.6" fill="#FFC24B"/>
</svg>`;

/** Serves the swrm favicon. Returns true if it handled the request. */
export function faviconHandler(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/favicon.svg' && path !== '/favicon.ico') return false;
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(FAVICON_SVG);
  return true;
}
