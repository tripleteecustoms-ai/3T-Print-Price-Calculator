// server/services/realtime.js
// Live updates for the admin dashboard: the browser keeps one event stream
// open (GET /api/admin/live) and is told when an order changes, so a payment
// that arrives from Shopify or Square shows up without a refresh.

const clients = new Set();

/** Express handler: holds the connection open and streams events to it. */
function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  clients.add(res);
  // A comment line every 25 seconds keeps proxies from closing a quiet stream.
  const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(beat); clients.delete(res); });
}

/** Tells every open admin page about a change: { type, orderNumber, message }. */
function publish(event) {
  const line = `data: ${JSON.stringify({ at: new Date().toISOString(), ...event })}\n\n`;
  for (const res of clients) { try { res.write(line); } catch (e) { clients.delete(res); } }
}

module.exports = { stream, publish };
