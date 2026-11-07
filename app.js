(() => {
  "use strict";

  const STORAGE_KEY = "eq-monitor-settings-v1";
  const LOCATION_KEY = "eq-monitor-location-v1";
  const CALLBACK_NAME = "__earthquakeMonitorJsonp";
  const DEFAULT_SETTINGS = {
    gasUrl: "",
    pollSeconds: 15,
    arrivalLeadSeconds: 30,
    notifyNew: true,
    notifyArrival: true,
    sound: true
  };
  const EARTH_RADIUS_KM = 6371;
  const P_WAVE_KM_S = 6.0;
  const S_WAVE_KM_S = 3.5;

  const state = {
    settings: loadSettings(),
    location: loadLocation(),
    events: [],
    selectedEventId: null,
    map: null,
    epicenterMarker: null,
    userMarker: null,
    pCircle: null,
    sCircle: null,
    pollTimer: null,
    tickingTimer: null,
    requestPending: false,
    firstSuccessfulLoad: false,
    seenEventIds: new Set(),
    sentAlertKeys: new Set(),
    toastTimer: null,
    audioContext: null,
    lastFetchAt: null
  };

  const $ = (id) => document.getElementById(id);

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return { ...DEFAULT_SETTINGS, ...saved };
    } catch (error) {
      console.warn("設定を読み込めませんでした。", error);
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettingsToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    } catch (error) {
      showToast("設定を保存できませんでした。ブラウザーの保存領域を確認してください。");
    }
  }

  function loadLocation() {
    try {
      const value = JSON.parse(localStorage.getItem(LOCATION_KEY) || "null");
      if (value && Number.isFinite(value.lat) && Number.isFinite(value.lon)) return value;
    } catch (error) {
      console.warn("位置情報を読み込めませんでした。", error);
    }
    return null;
  }

  function saveLocation() {
    try {
      if (state.location) localStorage.setItem(LOCATION_KEY, JSON.stringify(state.location));
      else localStorage.removeItem(LOCATION_KEY);
    } catch (error) {
      showToast("位置情報を端末内に保存できませんでした。");
    }
  }

  function init() {
    bindEvents();
    applySettingsToForm();
    updateClock();
    updateLocationDisplay();
    updateNotificationState();
    initMap();
    startTicker();
    restartPolling();
    registerServiceWorker();
    if (state.location && state.map) drawUserMarker();
  }

  function bindEvents() {
    $("settingsButton").addEventListener("click", openSettings);
    $("openSettingsInline").addEventListener("click", openSettings);
    $("refreshButton").addEventListener("click", () => fetchLatest(true));
    $("locateButton").addEventListener("click", requestLocation);
    $("locationButton").addEventListener("click", requestLocation);
    $("enableNotificationsButton").addEventListener("click", requestNotificationPermission);
    $("soundToggle").addEventListener("change", (event) => {
      state.settings.sound = event.target.checked;
      saveSettingsToStorage();
      if (state.settings.sound) playNotificationTone();
    });
    $("testConnectionButton").addEventListener("click", testConnection);
    $("saveSettingsButton").addEventListener("click", saveSettingsFromForm);
    $("pollIntervalInput").addEventListener("change", () => {
      $("pollingLabel").textContent = Number($("pollIntervalInput").value) + "秒ごと";
    });
    $("settingsDialog").addEventListener("click", (event) => {
      if (event.target === $("settingsDialog")) $("settingsDialog").close();
    });
  }

  function initMap() {
    const placeholder = $("mapPlaceholder");
    if (!window.L) {
      placeholder.textContent = "地図ライブラリを読み込めませんでした。ネットワークを確認してください。";
      return;
    }
    state.map = L.map("map", { zoomControl: true, scrollWheelZoom: true }).setView([36.2, 138.2], 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(state.map);
    placeholder.classList.add("hidden");
    if (state.location) drawUserMarker();
    window.setTimeout(() => state.map && state.map.invalidateSize(), 250);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service Workerの登録に失敗しました。", error);
    });
  }

  function startTicker() {
    window.clearInterval(state.tickingTimer);
    state.tickingTimer = window.setInterval(() => {
      updateClock();
      renderWaveCountdown();
      updateWaveCircles();
    }, 1000);
  }

  function updateClock() {
    const now = new Date();
    $("currentClock").textContent = now.toLocaleTimeString("ja-JP", { hour12: false });
    $("currentDate").textContent = now.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  }

  function restartPolling() {
    window.clearInterval(state.pollTimer);
    const seconds = clamp(Number(state.settings.pollSeconds) || 15, 15, 60);
    $("pollingLabel").textContent = seconds + "秒ごと";
    if (state.settings.gasUrl) {
      fetchLatest(false);
      state.pollTimer = window.setInterval(() => fetchLatest(false), seconds * 1000);
    } else {
      setConnection("idle", "未接続");
      setBanner("GAS APIを設定してください", "設定からGAS WebアプリのURLを登録すると、地震情報を取得できます。", "idle");
      renderEmptyEvents("GAS APIを設定すると地震情報が表示されます。");
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeGasUrl(value) {
    const input = String(value || "").trim();
    if (!input) throw new Error("GAS WebアプリURLを入力してください。");
    let url;
    try {
      url = new URL(input);
    } catch (_) {
      throw new Error("URLの形式を確認してください。");
    }
    if (url.protocol !== "https:" || url.hostname !== "script.google.com" || !url.pathname.includes("/macros/s/") || !url.pathname.endsWith("/exec")) {
      throw new Error("https://script.google.com/macros/s/.../exec のURLを入力してください。");
    }
    url.hash = "";
    return url.toString();
  }

  function jsonpRequest(baseUrl, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(normalizeGasUrl(baseUrl));
      } catch (error) {
        reject(error);
        return;
      }

      const script = document.createElement("script");
      let settled = false;
      const cleanup = () => {
        window.clearTimeout(timer);
        script.remove();
        try { delete window[CALLBACK_NAME]; } catch (_) { window[CALLBACK_NAME] = undefined; }
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };

      window[CALLBACK_NAME] = (payload) => finish(resolve, payload);
      url.searchParams.set("action", "latest");
      url.searchParams.set("callback", CALLBACK_NAME);
      url.searchParams.set("_", String(Date.now()));
      script.async = true;
      script.src = url.toString();
      script.onerror = () => finish(reject, new Error("GAS APIを読み込めませんでした。デプロイ設定とアクセス権を確認してください。"));
      const timer = window.setTimeout(() => finish(reject, new Error("GAS APIの応答がタイムアウトしました。")), timeoutMs);
      document.head.appendChild(script);
    });
  }

  async function fetchLatest(manual = false, urlOverride = "") {
    if (state.requestPending) {
      if (manual) showToast("更新処理中です。少し待ってください。");
      return null;
    }
    const baseUrl = urlOverride || state.settings.gasUrl;
    if (!baseUrl) {
      if (manual) openSettings();
      return null;
    }
    state.requestPending = true;
    if (manual) showToast("地震情報を取得しています…");
    try {
      const payload = await jsonpRequest(baseUrl);
      if (!payload || payload.ok !== true || !Array.isArray(payload.events)) {
        const message = payload && payload.error ? String(payload.error) : "GAS APIの応答形式が正しくありません。";
        throw new Error(message);
      }
      const events = payload.events.map(normalizeEvent).filter(Boolean).sort((a, b) => b.publishedAtMs - a.publishedAtMs);
      const newEvents = state.firstSuccessfulLoad
        ? events.filter((event) => !state.seenEventIds.has(event.id))
        : [];
      events.forEach((event) => state.seenEventIds.add(event.id));
      state.events = events;
      state.lastFetchAt = new Date();
      if (!state.selectedEventId || !events.some((event) => event.id === state.selectedEventId)) {
        state.selectedEventId = events[0] ? events[0].id : null;
      }
      state.firstSuccessfulLoad = true;
      renderEvents();
      renderWaveCountdown();
      updateWaveCircles();
      updateMapForSelectedEvent(false);
      $("lastUpdated").textContent = formatTime(payload.updatedAt || payload.serverTime || state.lastFetchAt.toISOString());
      $("eventCount").textContent = String(events.length);
      $("sourceName").textContent = payload.source || "GAS / 気象庁データ";
      setConnection("online", "接続中");
      setBanner("地震情報を取得しています", events.length ? "最新データを受信しました。画面上のカウントダウンは1秒ごとに更新されます。" : "取得は成功しましたが、現在表示できる地震情報はありません。", "connected");
      if (newEvents.length) notifyNewEvents(newEvents);
      if (manual) showToast("地震情報を更新しました。");
      return payload;
    } catch (error) {
      console.error("地震情報の取得に失敗しました。", error);
      setConnection("error", "取得エラー");
      setBanner("地震情報を取得できません", error.message || "GAS APIとの接続を確認してください。", "error");
      if (manual) showToast(error.message || "取得に失敗しました。");
      return null;
    } finally {
      state.requestPending = false;
    }
  }

  function normalizeEvent(raw) {
    if (!raw || typeof raw !== "object") return null;
    const publishedAt = parseDate(raw.publishedAt);
    const originAt = parseDate(raw.originTime);
    const latitude = toFiniteOrNull(raw.latitude);
    const longitude = toFiniteOrNull(raw.longitude);
    const depthKm = toFiniteOrNull(raw.depthKm);
    const magnitude = toFiniteOrNull(raw.magnitude);
    const id = String(raw.id || raw.url || (String(raw.title || "地震情報") + "-" + (raw.publishedAt || "")));
    if (!id || !publishedAt) return null;
    return {
      id,
      title: String(raw.title || "地震情報"),
      publishedAt,
      publishedAtMs: publishedAt.getTime(),
      originAt,
      hypocenter: String(raw.hypocenter || "震源地不明"),
      latitude: latitude !== null && latitude >= -90 && latitude <= 90 ? latitude : null,
      longitude: longitude !== null && longitude >= -180 && longitude <= 180 ? longitude : null,
      depthKm: depthKm !== null && depthKm >= 0 ? depthKm : null,
      magnitude: magnitude !== null && magnitude >= 0 ? magnitude : null,
      maxIntensity: String(raw.maxIntensity || "—"),
      kind: String(raw.kind || "earthquake"),
      url: safeHttpUrl(raw.url)
    };
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function toFiniteOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function safeHttpUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
    } catch (_) {
      return "";
    }
  }

  function renderEvents() {
    const list = $("eventList");
    if (!state.events.length) {
      renderEmptyEvents("現在、表示できる地震情報はありません。");
      return;
    }
    list.replaceChildren();
    state.events.slice(0, 20).forEach((event) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "event-item" + (event.id === state.selectedEventId ? " selected" : "");
      button.setAttribute("aria-pressed", event.id === state.selectedEventId ? "true" : "false");

      const top = document.createElement("span");
      top.className = "event-topline";
      const time = document.createElement("span");
      time.className = "event-time";
      time.textContent = formatDateTime(event.publishedAt);
      const intensity = document.createElement("span");
      intensity.className = "intensity-badge";
      intensity.textContent = event.maxIntensity === "—" ? "震度 —" : "最大震度 " + event.maxIntensity;
      top.append(time, intensity);

      const title = document.createElement("span");
      title.className = "event-title";
      title.textContent = event.title;
      const meta = document.createElement("span");
      meta.className = "event-meta";
      const place = document.createElement("span");
      place.textContent = event.hypocenter;
      const magnitude = document.createElement("span");
      magnitude.className = "mag";
      magnitude.textContent = event.magnitude === null ? "M —" : "M " + event.magnitude.toFixed(1);
      meta.append(place, magnitude);
      button.append(top, title, meta);
      button.addEventListener("click", () => selectEvent(event.id));
      list.append(button);
    });
    $("eventCount").textContent = String(state.events.length);
  }

  function renderEmptyEvents(message) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact";
    empty.textContent = message;
    $("eventList").replaceChildren(empty);
    $("eventCount").textContent = "--";
  }

  function selectEvent(id) {
    state.selectedEventId = id;
    renderEvents();
    renderWaveCountdown();
    updateMapForSelectedEvent(true);
    updateWaveCircles();
  }

  function selectedEvent() {
    return state.events.find((event) => event.id === state.selectedEventId) || null;
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const rad = (degree) => degree * Math.PI / 180;
    const dLat = rad(lat2 - lat1);
    const dLon = rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
    const surface = 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, a)));
    const depth = Math.max(0, Number.isFinite(lat1) ? (selectedEvent()?.depthKm || 0) : 0);
    return Math.sqrt(surface * surface + depth * depth);
  }

  function getArrivalData(event) {
    if (!event || !state.location || !event.originAt || event.latitude === null || event.longitude === null) return null;
    const distance = distanceKm(state.location.lat, state.location.lon, event.latitude, event.longitude);
    return {
      distance,
      pAt: event.originAt.getTime() + (distance / P_WAVE_KM_S) * 1000,
      sAt: event.originAt.getTime() + (distance / S_WAVE_KM_S) * 1000
    };
  }

  function renderWaveCountdown() {
    const event = selectedEvent();
    const data = getArrivalData(event);
    $("waveEmpty").hidden = !!data;
    $("waveContent").hidden = !data;
    if (!data) {
      if (event && !state.location) $("waveEmpty").textContent = "現在地を設定すると、選択中の地震情報から到達目安を計算します。";
      else if (event && !event.originAt) $("waveEmpty").textContent = "この地震情報には発震時刻または震源座標がないため、波の到達目安を計算できません。";
      else $("waveEmpty").textContent = "地震情報と現在地を設定すると、P波・S波の到達目安を表示します。";
      return;
    }
    $("selectedHypocenter").textContent = event.hypocenter;
    $("selectedMagnitude").textContent = event.magnitude === null ? "M —" : "M " + event.magnitude.toFixed(1);
    $("distanceValue").textContent = Math.round(data.distance).toLocaleString("ja-JP") + " km";
    const now = Date.now();
    updateCountdownField("p", data.pAt, now);
    updateCountdownField("s", data.sAt, now);
    $("estimateNote").textContent = "平均速度 P波 " + P_WAVE_KM_S.toFixed(1) + " km/s・S波 " + S_WAVE_KM_S.toFixed(1) + " km/s の簡易モデル。実際の到達時刻とは異なります。";
    checkArrivalAlerts(event, data, now);
  }

  function updateCountdownField(prefix, arrivalAt, now) {
    const remaining = arrivalAt - now;
    const text = remaining <= 0 ? "到達時刻経過" : formatRemaining(remaining);
    $(prefix + "Countdown").textContent = text;
    $(prefix + "ArrivalText").textContent = "到達目安 " + new Date(arrivalAt).toLocaleTimeString("ja-JP", { hour12: false });
  }

  function formatRemaining(milliseconds) {
    const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    if (hours > 0) return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
    return String(minutes).padStart(2, "0") + ":" + String(rest).padStart(2, "0");
  }

  function checkArrivalAlerts(event, data, now) {
    if (!state.settings.notifyArrival || !("Notification" in window) || Notification.permission !== "granted") return;
    const lead = Math.max(0, Number(state.settings.arrivalLeadSeconds) || 0) * 1000;
    [["P", data.pAt], ["S", data.sAt]].forEach(([wave, arrival]) => {
      const remaining = arrival - now;
      const threshold = lead === 0 ? 0 : lead;
      const shouldSend = lead === 0 ? remaining <= 0 && remaining > -1200 : remaining <= threshold && remaining > threshold - 1200;
      const key = event.id + ":" + wave + ":" + (lead === 0 ? "arrival" : "lead");
      if (shouldSend && !state.sentAlertKeys.has(key)) {
        state.sentAlertKeys.add(key);
        sendNotification(wave + "波の到達目安", event.hypocenter + "付近への" + wave + "波の到達目安時刻です。実際の到達を保証するものではありません。");
      }
    });
  }

  function notifyNewEvents(events) {
    if (!state.settings.notifyNew || !("Notification" in window) || Notification.permission !== "granted") return;
    events.slice(0, 3).forEach((event) => {
      sendNotification("新しい地震情報", event.title + " / " + event.hypocenter + (event.magnitude === null ? "" : " / M" + event.magnitude.toFixed(1)));
    });
  }

  function sendNotification(title, body) {
    try {
      new Notification(title, { body, icon: "./icons/icon.svg", badge: "./icons/icon.svg", tag: "eqm-" + title });
      if (state.settings.sound) playNotificationTone();
    } catch (error) {
      console.warn("通知を表示できませんでした。", error);
    }
  }

  function playNotificationTone() {
    if (!state.settings.sound) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      state.audioContext = state.audioContext || new AudioContextClass();
      if (state.audioContext.state === "suspended") state.audioContext.resume();
      const oscillator = state.audioContext.createOscillator();
      const gain = state.audioContext.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 740;
      gain.gain.setValueAtTime(0.0001, state.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, state.audioContext.currentTime + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, state.audioContext.currentTime + 0.28);
      oscillator.connect(gain);
      gain.connect(state.audioContext.destination);
      oscillator.start();
      oscillator.stop(state.audioContext.currentTime + 0.3);
    } catch (error) {
      console.warn("通知音を再生できませんでした。", error);
    }
  }

  function updateMapForSelectedEvent(zoomToEvent) {
    if (!state.map) return;
    const event = selectedEvent();
    clearEpicenter();
    if (!event || event.latitude === null || event.longitude === null) {
      $("mapCaption").textContent = "選択中の地震情報に震源座標がありません。";
      return;
    }
    const point = [event.latitude, event.longitude];
    const markerIcon = L.divIcon({ className: "", html: '<div class="epicenter-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
    state.epicenterMarker = L.marker(point, { icon: markerIcon, keyboard: true })
      .addTo(state.map)
      .bindPopup("<strong>" + escapeHtml(event.hypocenter) + "</strong><br>" + escapeHtml(event.title));
    if (zoomToEvent) {
      const points = [point];
      if (state.location) points.push([state.location.lat, state.location.lon]);
      if (points.length > 1) state.map.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 8 });
      else state.map.setView(point, 7);
    }
    $("mapCaption").textContent = event.hypocenter + " / " + (event.magnitude === null ? "M —" : "M " + event.magnitude.toFixed(1));
  }

  function clearEpicenter() {
    if (state.epicenterMarker && state.map) state.map.removeLayer(state.epicenterMarker);
    state.epicenterMarker = null;
    clearWaveCircles();
  }

  function drawUserMarker() {
    if (!state.map || !state.location) return;
    if (state.userMarker) state.map.removeLayer(state.userMarker);
    const userIcon = L.divIcon({ className: "", html: '<div class="user-marker"></div>', iconSize: [13, 13], iconAnchor: [6.5, 6.5] });
    state.userMarker = L.marker([state.location.lat, state.location.lon], { icon: userIcon })
      .addTo(state.map)
      .bindPopup("この端末の観測地点（端末内保存）");
  }

  function updateWaveCircles() {
    if (!state.map) return;
    const event = selectedEvent();
    const data = getArrivalData(event);
    if (!data) {
      clearWaveCircles();
      return;
    }
    const elapsed = Math.max(0, (Date.now() - event.originAt.getTime()) / 1000);
    const pRadius = Math.min(P_WAVE_KM_S * elapsed, 20000) * 1000;
    const sRadius = Math.min(S_WAVE_KM_S * elapsed, 20000) * 1000;
    if (!state.pCircle) {
      state.pCircle = L.circle([event.latitude, event.longitude], { radius: pRadius, color: "#55d6e8", weight: 2, fillColor: "#55d6e8", className: "wave-circle", interactive: false }).addTo(state.map);
    } else {
      state.pCircle.setLatLng([event.latitude, event.longitude]).setRadius(pRadius);
    }
    if (!state.sCircle) {
      state.sCircle = L.circle([event.latitude, event.longitude], { radius: sRadius, color: "#ffad61", weight: 2, fillColor: "#ffad61", className: "wave-circle", interactive: false }).addTo(state.map);
    } else {
      state.sCircle.setLatLng([event.latitude, event.longitude]).setRadius(sRadius);
    }
  }

  function clearWaveCircles() {
    if (!state.map) return;
    if (state.pCircle) state.map.removeLayer(state.pCircle);
    if (state.sCircle) state.map.removeLayer(state.sCircle);
    state.pCircle = null;
    state.sCircle = null;
  }

  function requestLocation() {
    if (!navigator.geolocation) {
      showToast("このブラウザーでは位置情報を利用できません。");
      return;
    }
    $("locationName").textContent = "位置情報を取得中…";
    navigator.geolocation.getCurrentPosition((position) => {
      state.location = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        accuracy: Number.isFinite(position.coords.accuracy) ? Math.round(position.coords.accuracy) : null,
        savedAt: new Date().toISOString()
      };
      saveLocation();
      updateLocationDisplay();
      drawUserMarker();
      renderWaveCountdown();
      updateWaveCircles();
      updateMapForSelectedEvent(true);
      showToast("現在地をこの端末に保存しました。");
    }, (error) => {
      const messages = {
        1: "位置情報の利用が許可されていません。ブラウザーの設定を確認してください。",
        2: "現在地を取得できませんでした。",
        3: "位置情報の取得がタイムアウトしました。"
      };
      updateLocationDisplay();
      showToast(messages[error.code] || "位置情報を取得できませんでした。");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  function updateLocationDisplay() {
    if (!state.location) {
      $("locationName").textContent = "未設定";
      $("locationCoords").textContent = "位置情報は未取得です";
      return;
    }
    $("locationName").textContent = "この端末の現在地";
    $("locationCoords").textContent = state.location.lat.toFixed(4) + ", " + state.location.lon.toFixed(4) + (state.location.accuracy ? "（精度 約" + state.location.accuracy + "m）" : "");
  }

  async function requestNotificationPermission() {
    if (!("Notification" in window)) {
      showToast("このブラウザーは通知に対応していません。");
      return;
    }
    if (Notification.permission === "granted") {
      updateNotificationState();
      showToast("通知はすでに許可されています。");
      return;
    }
    if (Notification.permission === "denied") {
      showToast("通知が拒否されています。ブラウザーまたは端末の設定から変更してください。");
      updateNotificationState();
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      updateNotificationState();
      showToast(permission === "granted" ? "通知を許可しました。" : "通知は許可されませんでした。");
      if (permission === "granted") sendNotification("通知テスト", "地震モニターの通知設定が完了しました。");
    } catch (error) {
      showToast("通知の許可を取得できませんでした。");
    }
  }

  function updateNotificationState() {
    let text = "非対応";
    let allowed = false;
    if ("Notification" in window) {
      if (Notification.permission === "granted") {
        text = "許可済み";
        allowed = true;
      } else if (Notification.permission === "denied") text = "拒否";
      else text = "未許可";
    }
    $("alertState").textContent = text;
    $("alertState").classList.toggle("allowed", allowed);
  }

  function openSettings() {
    applySettingsToForm();
    $("settingsFeedback").textContent = "";
    $("settingsFeedback").className = "dialog-feedback";
    $("settingsDialog").showModal();
  }

  function applySettingsToForm() {
    $("gasUrlInput").value = state.settings.gasUrl || "";
    $("pollIntervalInput").value = String(state.settings.pollSeconds || 15);
    $("arrivalLeadInput").value = String(state.settings.arrivalLeadSeconds ?? 30);
    $("newEventToggle").checked = !!state.settings.notifyNew;
    $("arrivalToggle").checked = !!state.settings.notifyArrival;
    $("soundToggle").checked = !!state.settings.sound;
    $("pollingLabel").textContent = (state.settings.pollSeconds || 15) + "秒ごと";
  }

  async function testConnection() {
    const feedback = $("settingsFeedback");
    feedback.className = "dialog-feedback";
    feedback.textContent = "接続を確認しています…";
    const url = $("gasUrlInput").value;
    try {
      normalizeGasUrl(url);
      const payload = await fetchLatest(false, url);
      if (!payload) throw new Error("接続できませんでした。URLとGASのデプロイ設定を確認してください。");
      feedback.textContent = "接続成功：地震情報を " + payload.events.length + " 件受信しました。";
      feedback.className = "dialog-feedback success";
    } catch (error) {
      feedback.textContent = error.message || "接続に失敗しました。";
      feedback.className = "dialog-feedback error";
    }
  }

  function saveSettingsFromForm() {
    try {
      const gasUrl = $("gasUrlInput").value.trim() ? normalizeGasUrl($("gasUrlInput").value) : "";
      state.settings = {
        gasUrl,
        pollSeconds: clamp(Number($("pollIntervalInput").value) || 15, 15, 60),
        arrivalLeadSeconds: clamp(Number($("arrivalLeadInput").value) || 0, 0, 60),
        notifyNew: $("newEventToggle").checked,
        notifyArrival: $("arrivalToggle").checked,
        sound: $("soundToggle").checked
      };
      saveSettingsToStorage();
      $("settingsDialog").close();
      restartPolling();
      showToast(gasUrl ? "設定を保存しました。地震情報を取得します。" : "設定を保存しました。GAS URLは未登録です。");
    } catch (error) {
      $("settingsFeedback").textContent = error.message;
      $("settingsFeedback").className = "dialog-feedback error";
    }
  }

  function setConnection(status, label) {
    const pill = $("connectionPill");
    pill.classList.toggle("online", status === "online");
    pill.classList.toggle("error", status === "error");
    $("connectionText").textContent = label;
  }

  function setBanner(title, description, status) {
    const banner = $("statusBanner");
    banner.classList.toggle("connected", status === "connected");
    banner.classList.toggle("error", status === "error");
    $("statusTitle").textContent = title;
    $("statusDescription").textContent = description;
    $("openSettingsInline").hidden = status === "connected";
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3000);
  }

  function formatTime(value) {
    const date = parseDate(value);
    if (!date) return "未取得";
    return date.toLocaleTimeString("ja-JP", { hour12: false });
  }

  function formatDateTime(date) {
    return date.toLocaleString("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  document.addEventListener("DOMContentLoaded", init);
})();