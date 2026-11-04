/* ============================================================
 * supabase-shim.js - menggantikan google.script.run di web Portal dengan Supabase.
 * Tahap 1: login + Pre-Register (lihat, edit satu data). Menu lain: pesan "belum tersedia".
 * Kunci di bawah adalah kunci PUBLIK (aman di browser). Kunci rahasia TIDAK ada di sini.
 * ============================================================ */
(function () {
  'use strict';
  var SB_URL = 'https://bvjcrjlzymdqjqslldqp.supabase.co';
  var SB_KEY = 'sb_publishable_ht8RdTmzOYEuL3Cb969DFA_D0imS6DT';
  var APPS_PING = 'https://script.google.com/macros/s/AKfycbyICWUHYy7-KGLNR2S93NP1tOEeF8TACHFIt99uYt21kvdcRew1zrRxAMBG-ycUDJZaKw/exec';
  var AUTH_KEY = 'sb_shim_auth';
  var DOMAIN = '@mitra.starlite.app';
  var PAGE = 1000, PARALEL = 6;
  var DATA_HEADERS = ['Nama Pelanggan', 'Nomor Telepon', 'Alamat', 'Nama Mitra', 'Provinsi', 'Kota', 'Kecamatan', 'Keluarahan', 'Stasiun',
    'Longitude', 'Latitude', 'Status', 'Remarks', 'Terakhir Diupdate', 'Riwayat Status', 'ID Pelanggan'];
  var BELUM = 'Menu ini belum tersedia di versi Supabase (tahap berikutnya). Gunakan web yang lama untuk saat ini.';

  function emailOf(u, n) {
    var d = String(u || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
    return d + (n > 1 ? '__' + n : '') + DOMAIN;
  }
  function getAuth() { try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { return null; } }
  function setAuth(a) { try { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch (e) { } }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function authPost(path, body) {
    return fetch(SB_URL + '/auth/v1/' + path, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  function simpanToken(j) { setAuth({ access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000 }); }

  async function tokenSah(paksa) {
    var a = getAuth();
    if (!a) throw new Error('Sesi login tidak ditemukan. Klik Keluar lalu login lagi.');
    if (!paksa && a.exp > Date.now()) return a.access;
    var r = await authPost('token?grant_type=refresh_token', { refresh_token: a.refresh });
    if (!r.ok) throw new Error('Sesi login sudah habis. Klik Keluar lalu login lagi.');
    var j = await r.json(); simpanToken(j); return j.access_token;
  }

  // Panggilan REST ke Supabase dengan token login (otomatis perbarui token bila kedaluwarsa)
  async function rest(path, opt) {
    opt = opt || {};
    for (var coba = 0; coba < 2; coba++) {
      var tok = await tokenSah(coba === 1);
      var h = Object.assign({ apikey: SB_KEY, Authorization: 'Bearer ' + tok }, opt.headers || {});
      if (opt.body !== undefined) h['Content-Type'] = 'application/json';
      var r = await fetch(SB_URL + '/rest/v1/' + path, { method: opt.method || 'GET', headers: h, body: opt.body === undefined ? undefined : JSON.stringify(opt.body) });
      if (r.status === 401 && coba === 0) continue;
      return r;
    }
  }
  async function restJson(path, opt) {
    var r = await rest(path, opt);
    if (!r.ok) { var t = ''; try { t = await r.text(); } catch (e) { } throw new Error('Server ' + r.status + ': ' + t.slice(0, 160)); }
    var tx = await r.text();
    return tx ? JSON.parse(tx) : null;
  }

  // ---------- Teruskan ke Apps Script (menu yang belum dipindah ke Supabase) ----------
  async function rpc(fn, args) {
    var r = await fetch(APPS_PING, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn: fn, args: args }) });
    var j = await r.json();
    if (!j.ok) throw new Error(j.error || 'Gagal memanggil server.');
    return j.result;
  }

  // ---------- LOGIN ----------
  async function login(username, password) {
    username = String(username || '').trim(); password = String(password || '').trim();
    if (!username || !password) return { success: false, message: 'Username dan password wajib diisi.' };
    for (var n = 1; n <= 4; n++) {
      var r = await authPost('token?grant_type=password', { email: emailOf(username, n), password: password });
      if (r.ok) {
        var j = await r.json(), md = (j.user && j.user.app_metadata) || {};
        simpanToken(j);
        var admin = md.role === 'admin'; try { localStorage.setItem('sb_shim_admin', admin ? '1' : '0'); } catch (e) { }
        if (!admin && md.role !== 'mitra') return { success: false, message: 'Akun ini belum diberi akses.' };
        var tok = '';
        try { var lr = await rpc('login', [username, password]); if (lr && lr.success) tok = lr.token || ''; } catch (e) { }
        return { success: true, namaMitra: admin ? 'Semua Mitra' : md.mitra, username: ((j.user.user_metadata || {}).username) || username, isAdmin: admin, token: tok };
      }
      if (r.status === 429) return { success: false, message: 'Terlalu banyak percobaan login. Coba lagi beberapa menit lagi.' };
      if (r.status >= 500) return { success: false, message: 'Server login sedang bermasalah. Coba lagi.' };
    }
    return { success: false, message: 'Username atau password salah.' };
  }

  // ---------- DATA PRE-REGISTER ----------
  async function getDataMitra() {
    var base = 'sheet_rows?select=data,row_n&sheet=eq.pre&order=row_n.asc';
    var r0 = await rest(base, { headers: { 'Range-Unit': 'items', Range: '0-' + (PAGE - 1), Prefer: 'count=exact' } });
    if (!r0.ok) { var t = ''; try { t = await r0.text(); } catch (e) { } return { success: false, message: 'Gagal memuat data (' + r0.status + '): ' + t.slice(0, 120), headers: DATA_HEADERS, rows: [] }; }
    var cr = r0.headers.get('Content-Range') || '', total = parseInt(cr.split('/')[1], 10) || 0;
    var pages = [await r0.json()];
    var offsets = [];
    for (var o = PAGE; o < total; o += PAGE) offsets.push(o);
    var hasil = new Array(offsets.length), idx = 0;
    async function pekerja() {
      while (idx < offsets.length) {
        var i = idx++, off = offsets[i];
        var r = await rest(base, { headers: { 'Range-Unit': 'items', Range: off + '-' + (off + PAGE - 1) } });
        if (!r.ok) throw new Error('Gagal memuat bagian data (' + r.status + ').');
        hasil[i] = await r.json();
      }
    }
    var workers = []; for (var w = 0; w < Math.min(PARALEL, offsets.length); w++) workers.push(pekerja());
    await Promise.all(workers);
    pages = pages.concat(hasil);
    var rows = [], rowIds = [];
    pages.forEach(function (pg) {
      pg.forEach(function (rec) {
        var d = rec.data || {};
        rows.push(DATA_HEADERS.map(function (h) { var v = d[h]; return v === null || v === undefined ? '' : String(v); }));
        rowIds.push(rec.row_n);
      });
    });
    return { success: true, headers: DATA_HEADERS, rows: rows, rowIds: rowIds };
  }

  // ---------- UPDATE SATU DATA (antrean di Supabase -> diproses Apps Script -> hasil dibaca kembali) ----------
  function ping() { try { fetch(APPS_PING + '?aksi=proses', { mode: 'no-cors' }).catch(function () { }); } catch (e) { } }

  async function updatePelangganStatus(rowId, namaMitra, status, remarks, isAdmin, idPelanggan, stasiun) {
    rowId = parseInt(rowId, 10);
    if (!rowId || rowId < 2) return { success: false, message: 'Baris data tidak valid.' };
    var mitra = String(namaMitra || '').trim();
    if (isAdmin) {
      var rm = await restJson('sheet_rows?select=mitra&sheet=eq.pre&row_key=eq.' + rowId);
      if (!rm || !rm.length) return { success: false, message: 'Baris data tidak ditemukan.' };
      mitra = rm[0].mitra || '';
    }
    if (!mitra) return { success: false, message: 'Sesi mitra tidak valid, silakan login ulang.' };
    var ins;
    try {
      ins = await restJson('mitra_updates', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: { sheet: 'pre', row_key: String(rowId), mitra: mitra, kategori: String(status || ''), remark: String(remarks || ''),
          id_pelanggan: String(idPelanggan || ''), stasiun: String(stasiun || ''), updated_by: isAdmin ? 'VMIJE (Admin)' : mitra }
      });
    } catch (e) { return { success: false, message: 'Gagal mengirim update: ' + e.message }; }
    var uid = ins && ins[0] && ins[0].id;
    if (!uid) return { success: false, message: 'Gagal mengirim update.' };
    ping();
    for (var i = 0; i < 40; i++) {
      await sleep(1500);
      if (i === 8 || i === 20) ping();
      var st = await restJson('mitra_updates?select=synced_at,error&id=eq.' + uid);
      if (st && st.length && st[0].synced_at) {
        if (st[0].error) return { success: false, message: st[0].error };
        var rr = await restJson('sheet_rows?select=data&sheet=eq.pre&row_key=eq.' + rowId);
        var d = (rr && rr[0] && rr[0].data) || {};
        return { success: true, terakhirDiupdate: d['Terakhir Diupdate'] || '', riwayatStatus: d['Riwayat Status'] || '', idPelanggan: d['ID Pelanggan'] || '', stasiun: d['Stasiun'] || String(stasiun || '') };
      }
    }
    return { success: false, message: 'Update sudah dikirim tetapi belum selesai diproses. Muat ulang data beberapa saat lagi untuk memastikan.' };
  }

  var IMPL = {
    login: login,
    getDataMitra: getDataMitra,
    updatePelangganStatus: updatePelangganStatus,
    getAppVersion: function () { return 'sb-1'; }
  };


  // ---------- SALINAN MENU DARI SUPABASE (WO, Potensial, FWA, MGM, Signal Low, riwayat update) ----------
  var SNAP = { getDataWO: 'wo', getDataPotensial: 'pot', getDataFWA: 'fwa', getDataMGM: 'mgm', getDataSignalLow: 'signal', getUpdateWO: 'updwo', getUpdatePotensial: 'updpot' };
  var TULIS = { updateWO: 1, bulkUpdateWO: 1, updatePotensial: 1, bulkUpdatePotensial: 1, updateMGM: 1, updateSignalLow: 1, bulkUpdateSignalLow: 1, bulkUpdatePelanggan: 1 };
  function snapReader(fn, menu) {
    return async function () {
      var args = Array.prototype.slice.call(arguments);
      var paksa = (fn.indexOf('getData') === 0 && fn !== 'getDataMGM' && fn !== 'getDataSignalLow') ? args[1] === true : false;
      if (!paksa) {
        try {
          var admin = localStorage.getItem('sb_shim_admin') === '1';
          var q = 'menu_snap?select=part,payload&menu=eq.' + menu + (admin ? '&scope=eq.admin' : '') + '&order=part.asc';
          var rows = await restJson(q);
          if (rows && rows.length) return JSON.parse(rows.map(function (r) { return r.payload; }).join(''));
        } catch (e) { console.warn('Salinan ' + menu + ' gagal, pakai server lama:', e); }
      }
      return rpc(fn, args);
    };
  }
  Object.keys(SNAP).forEach(function (fn) { IMPL[fn] = snapReader(fn, SNAP[fn]); });

  // ---------- google.script.run versi Supabase ----------
  function runner(ok, bad) {
    var base = {
      withSuccessHandler: function (f) { return runner(f, bad); },
      withFailureHandler: function (f) { return runner(ok, f); }
    };
    return new Proxy(base, {
      get: function (t, name) {
        if (name in t) return t[name];
        return function () {
          var args = Array.prototype.slice.call(arguments);
          Promise.resolve().then(function () {
            return IMPL[name] ? IMPL[name].apply(null, args) : rpc(name, args).then(function (r) { if (TULIS[name]) ping(); return r; });
          }).then(function (r) { if (ok) ok(r); }, function (e) { if (bad) bad(e); else console.error(e); });
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = { run: runner(null, null) };
  window.sbShimLogout = function () { try { localStorage.removeItem(AUTH_KEY); } catch (e) { } };
  window.__sbShim = { emailOf: emailOf, IMPL: IMPL };
})();
