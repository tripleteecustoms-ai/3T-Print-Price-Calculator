// public/js/account-link.js — the header's account link on the ordering pages.
// It reads "Login" for a guest and "My Account" once signed in. An account is
// optional: nothing here is needed to place an order.
// window.customerAccount resolves to the signed-in customer's profile (or
// null), so the order forms can fill in a returning customer's details.
window.customerAccount = fetch('/api/account/me').then(r => r.json()).then(me => {
  const link = document.getElementById('accountLink');
  if (link && me.loggedIn) { link.textContent = 'My Account'; link.href = '/account'; }
  if (me.loggedIn) return me.profile;
  // Not signed in: an order already in the cart supplies the same contact details for the next one.
  try { return JSON.parse(localStorage.getItem('3t_cart_contact')) || null; } catch (e) { return null; }
}).catch(() => null);
