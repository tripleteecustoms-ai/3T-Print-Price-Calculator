// public/js/cart.js — the cart, shared by every ordering page.
//
// A customer can order different products together: each one is built and
// saved as its own order, added to the cart, and the cart is paid for in one
// checkout (shipping charged once). The browser only remembers the cart's
// token; the orders, prices and totals always come from the server.
(function () {
  const KEY = '3t_cart_token';
  const token = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
  const remember = (cart) => {
    try {
      if (cart && cart.token && cart.status !== 'paid') localStorage.setItem(KEY, cart.token); else localStorage.removeItem(KEY);
      if (cart && cart.contact) localStorage.setItem('3t_cart_contact', JSON.stringify(cart.contact));
    } catch (e) { /* the cart still works for this page */ }
    return cart;
  };
  async function call(method, path, body) {
    const resp = await fetch('/api/cart' + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(json.error || 'Something went wrong with your cart.');
    return json;
  }

  const Cart = {
    token,
    /** Adds a finished (unpaid) order to the cart, starting a cart if there is none. */
    async add(orderNumber) { const cart = remember(await call('POST', '/add', { cartToken: token() || undefined, orderNumber })); showLink(cart); return cart; },
    /** The current cart, or null when there is none. */
    async get() {
      if (!token()) return null;
      try { return remember(await call('GET', '/' + encodeURIComponent(token()))); }
      catch (e) { try { localStorage.removeItem(KEY); } catch (err) {} return null; }
    },
    async remove(orderNumber) { return remember(await call('POST', `/${encodeURIComponent(token())}/remove`, { orderNumber })); },
    async checkout() { return call('POST', `/${encodeURIComponent(token())}/checkout`, { termsAccepted: true }); },
    forget() { try { localStorage.removeItem(KEY); } catch (e) {} },
  };
  window.Cart = Cart;

  // A "Cart (2)" link in the page header whenever the cart has something in it.
  function showLink(cart) {
    const host = document.querySelector('.site-header .header-actions') || document.querySelector('.site-header');
    if (!host) return;
    let link = document.getElementById('cartLink');
    const count = cart ? cart.items.filter(i => !i.paid).length : 0;
    if (!count || cart.status === 'paid') { if (link) link.remove(); return; }
    if (!link) {
      link = document.createElement('a');
      link.id = 'cartLink';
      link.href = '/cart.html';
      link.style.cssText = 'background:#CCFF00;color:#000;font-weight:800;font-size:12px;padding:7px 12px;border-radius:999px;text-decoration:none;white-space:nowrap;';
      host.insertBefore(link, host.firstChild);
    }
    link.textContent = `Cart (${count})`;
  }
  if (token() && !/\/cart\.html$/.test(location.pathname)) Cart.get().then(showLink);
})();
