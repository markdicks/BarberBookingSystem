const $ = (selector) => document.querySelector(selector);
const state = { config: null, customer: null, selectedTime: null, pendingBooking: false };

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Please try again.');
  return data;
}

function post(url, body) { return api(url, { method: 'POST', body: JSON.stringify(body) }); }
function dateLabel(iso) { return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' }); }
function money(value) { return `R${value}`; }
function surcharge(time) { return time >= '20:00' ? 30 : time >= '19:00' ? 20 : time >= '18:00' ? 10 : 0; }
function message(selector, value, error = false) { const element = $(selector); element.textContent = value; element.className = `message ${error ? 'error' : 'success-text'}`; }
function selectedService() { return state.config?.services.find(service => service.key === $('#service-select').value); }

function renderServices() {
  const select = $('#service-select');
  const grid = $('#service-cards');
  state.config.services.forEach((service, index) => {
    const option = document.createElement('option');
    option.value = service.key;
    option.textContent = `${service.name} — ${money(service.price)}`;
    select.append(option);
    const card = document.createElement('article');
    card.className = 'service-card';
    const number = document.createElement('span'); number.className = 'service-number'; number.textContent = `0${index + 1} / SERVICE`;
    const icon = document.createElement('span'); icon.className = 'service-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '✦';
    const details = document.createElement('div');
    const title = document.createElement('h3'); title.textContent = service.name;
    const price = document.createElement('strong'); price.textContent = money(service.price);
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Book this service ↗';
    button.addEventListener('click', () => { select.value = service.key; updateTotal(); $('#book').scrollIntoView({ behavior: 'smooth' }); });
    details.append(title, price);
    card.append(number, icon, details, button);
    grid.append(card);
  });
}

function renderHours() {
  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  names.forEach((name, index) => {
    const hours = state.config.schedule[String(index + 1)];
    const row = document.createElement('div'); row.className = 'hours-row';
    const label = document.createElement('div'); label.textContent = name;
    const value = document.createElement('span'); value.textContent = hours ? `${hours[0]} – ${hours[1]}` : 'Closed';
    row.append(label, value); $('#hours-list').append(row);
  });
  const sunday = state.config.schedule['7'];
  $('.hours-footer span').textContent = sunday ? `${sunday[0]} – ${sunday[1]}` : 'Closed';
}

async function loadSlots() {
  const date = $('#date-select').value;
  const list = $('#slot-list');
  state.selectedTime = null;
  updateTotal();
  list.replaceChildren();
  if (!date) { list.textContent = 'Choose a day to see free times.'; return; }
  list.textContent = 'Checking available times…';
  try {
    const { slots } = await api(`/api/availability?date=${encodeURIComponent(date)}`);
    if ($('#date-select').value !== date) return;
    list.replaceChildren();
    if (!slots.length) { const note = document.createElement('p'); note.className = 'muted'; note.textContent = 'No free slots on this day. Please try another date.'; list.append(note); return; }
    slots.forEach(time => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'slot-button'; button.textContent = time; button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        list.querySelectorAll('button').forEach(item => { item.classList.remove('selected'); item.setAttribute('aria-pressed', 'false'); });
        button.classList.add('selected'); button.setAttribute('aria-pressed', 'true'); state.selectedTime = time; updateTotal(); message('#booking-message', '');
      });
      list.append(button);
    });
  } catch (error) { list.textContent = 'Could not load times. Please try again.'; }
}

function updateTotal() {
  const service = selectedService();
  if (!service || !state.selectedTime) { $('#total-price').textContent = '—'; $('#total-detail').textContent = 'Choose a service and time'; return; }
  const extra = surcharge(state.selectedTime);
  $('#total-price').textContent = money(service.price + extra);
  $('#total-detail').textContent = extra ? `${money(service.price)} service + ${money(extra)} after-hours` : `${service.name} · 30 minutes`;
}

function showAuth(forBooking) {
  state.pendingBooking = forBooking;
  message('#auth-message', '');
  $('#auth-fields').hidden = false;
  $('#code-fields').hidden = true;
  $('#code-input').value = '';
  $('#dialog-title').textContent = forBooking ? 'One last step.' : 'Quick sign in.';
  $('#dialog-subtitle').textContent = forBooking ? 'Confirm your number to finish this booking. Your account is created on your first visit.' : 'Enter your mobile number. We’ll send a one-time code on WhatsApp.';
  $('#account-dialog').showModal();
  $('#phone-input').focus();
}

async function finishBooking() {
  const service = selectedService();
  if (!service || !$('#date-select').value || !state.selectedTime) { message('#booking-message', 'Choose a service, day and time first.', true); return; }
  const button = $('#continue-booking'); button.disabled = true; button.textContent = 'Confirming…';
  try {
    const { booking } = await post('/api/bookings', { serviceKey: service.key, date: $('#date-select').value, time: state.selectedTime });
    $('#booking-form').hidden = true; $('#booking-success').hidden = false;
    $('#success-detail').textContent = `${booking.service} on ${dateLabel(booking.date)} at ${booking.time}. Total ${money(booking.total)}. We’ll see you at 1 Braam Street, Alberton.`;
    $('#booking-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    message('#booking-message', error.message, true);
    await loadSlots();
  } finally { button.disabled = false; button.innerHTML = 'Continue to confirm <span aria-hidden="true">↗</span>'; }
}

async function showBookings() {
  if (!state.customer) return showAuth(false);
  const dialog = $('#bookings-dialog');
  $('#welcome-name').textContent = `Hi ${state.customer.name}. Here are your appointments.`;
  $('#my-bookings').textContent = 'Loading…';
  dialog.showModal();
  try {
    const { bookings } = await api('/api/bookings');
    const list = $('#my-bookings'); list.replaceChildren();
    if (!bookings.length) { const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = 'No bookings yet. Your next great cut is waiting.'; list.append(empty); return; }
    bookings.forEach(booking => {
      const row = document.createElement('div'); row.className = `my-booking ${booking.status}`;
      const info = document.createElement('div');
      const title = document.createElement('strong'); title.textContent = `${dateLabel(booking.date)} · ${booking.time}`;
      const detail = document.createElement('small');
      const service = state.config.services.find(item => item.key === booking.serviceKey);
      detail.textContent = `${service?.name || booking.serviceKey} · ${money(booking.price + booking.surcharge)} · ${booking.status}${booking.cancellationFee ? ` · R${booking.cancellationFee} late cancellation fee` : ''}`;
      info.append(title, detail); row.append(info);
      if (booking.status === 'confirmed' && new Date(`${booking.date}T${booking.time}:00+02:00`).getTime() > Date.now()) {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', async () => {
          if (!window.confirm('Cancel this appointment? A R80 fee applies if it is within 3 hours of your slot.')) return;
          try { const result = await api(`/api/bookings/${encodeURIComponent(booking.id)}`, { method: 'DELETE' }); if (result.cancellationFee) window.alert('Cancelled. A R80 late cancellation fee applies.'); dialog.close(); await showBookings(); }
          catch (error) { window.alert(error.message); }
        });
        row.append(cancel);
      }
      list.append(row);
    });
  } catch (error) { $('#my-bookings').textContent = error.message; }
}

async function init() {
  try {
    state.config = await api('/api/config');
    state.customer = (await api('/api/me')).customer;
    renderServices(); renderHours();
    $('#date-select').min = state.config.today;
    $('#date-select').max = state.config.maxDate;
    let firstOpen = state.config.today;
    for (let offset = 0; offset < 7; offset++) {
      const day = new Date(`${state.config.today}T12:00:00Z`);
      day.setUTCDate(day.getUTCDate() + offset);
      const candidate = day.toISOString().slice(0, 10);
      const availability = await api(`/api/availability?date=${candidate}`);
      if (availability.slots.length) { firstOpen = candidate; break; }
    }
    $('#date-select').value = firstOpen;
    await loadSlots();
    $('#year').textContent = new Date().getFullYear();
    if (state.config.whatsappNumber) {
      const number = state.config.whatsappNumber.replace(/\D/g, '');
      if (number) { $('#whatsapp-link').href = `https://wa.me/${number}?text=BOOK`; $('#whatsapp-link').hidden = false; }
    }
  } catch (error) { message('#booking-message', 'The booking service is temporarily unavailable. Please try again shortly.', true); }
}

$('#service-select').addEventListener('change', updateTotal);
$('#date-select').addEventListener('change', loadSlots);
$('#continue-booking').addEventListener('click', () => { if (!selectedService() || !$('#date-select').value || !state.selectedTime) return message('#booking-message', 'Choose a service, day and time first.', true); state.customer ? finishBooking() : showAuth(true); });
$('#account-nav').addEventListener('click', showBookings);
$('#view-bookings').addEventListener('click', showBookings);
$('#book-another').addEventListener('click', async () => { $('#booking-success').hidden = true; $('#booking-form').hidden = false; await loadSlots(); });
$('#close-dialog').addEventListener('click', () => $('#account-dialog').close());
$('#close-bookings').addEventListener('click', () => $('#bookings-dialog').close());
$('#change-number').addEventListener('click', () => { $('#auth-fields').hidden = false; $('#code-fields').hidden = true; message('#auth-message', ''); });
$('#send-code').addEventListener('click', async () => {
  const button = $('#send-code'); button.disabled = true; button.textContent = 'Sending…';
  try { const result = await post('/api/auth/start', { phone: $('#phone-input').value }); $('#phone-input').value = result.phone; $('#auth-fields').hidden = true; $('#code-fields').hidden = false; $('#code-sent').textContent = result.message; message('#auth-message', ''); $('#code-input').focus(); }
  catch (error) { message('#auth-message', error.message, true); }
  finally { button.disabled = false; button.textContent = 'Send WhatsApp code'; }
});
$('#verify-code').addEventListener('click', async () => {
  const button = $('#verify-code'); button.disabled = true; button.textContent = 'Verifying…';
  try {
    const { customer } = await post('/api/auth/verify', { phone: $('#phone-input').value, name: $('#name-input').value, code: $('#code-input').value });
    state.customer = customer; $('#account-dialog').close();
    if (state.pendingBooking) { state.pendingBooking = false; await finishBooking(); }
    else await showBookings();
  } catch (error) { message('#auth-message', error.message, true); }
  finally { button.disabled = false; button.textContent = 'Verify & continue'; }
});
$('#logout').addEventListener('click', async () => { await post('/api/auth/logout', {}); state.customer = null; $('#bookings-dialog').close(); });
init();
