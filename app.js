/* ═══════════════════════════════════════════════════════════════
   GeoGuesser Party Game — Application Logic
   ═══════════════════════════════════════════════════════════════ */

// ── Game State ──────────────────────────────────────────────────
const state = {
  role: null,           // 'admin' | 'player'
  teamName: "",
  gameCode: 0,          // 4-digit code to sync locations across devices
  totalRounds: 5,
  timerDuration: 60,    // seconds
  currentRound: 0,      // 0 = demo
  isDemoRound: true,
  locations: [],        // shuffled subset for this game
  demoLocation: null,   // always LOCATIONS[0]
  currentGuess: null,   // { lat, lng }
  scores: [],           // [{ round, distance, points, locationName }]
  totalScore: 0,
  timerInterval: null,
  timeLeft: 0,
  roundActive: false,
  guessLocked: false,

  // Leaflet objects
  playerMap: null,
  adminRevealMap: null,
  guessMarker: null,
  correctMarker: null,
  distanceLine: null,
  adminCorrectMarker: null,
};

// ── Helpers ─────────────────────────────────────────────────────

/** Haversine distance in km */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Score from distance (max 5000) */
function calculateScore(distanceKm) {
  return Math.round(5000 * Math.exp(-distanceKm / 2000));
}

/** Format distance nicely */
function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

/** Shuffle array in-place (Fisher-Yates) */
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Seeded pseudo-random number generator (LCG) */
function seededRandom(seed) {
  let s = Math.abs(seed) || 1;
  return function () {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Deterministic shuffle using a seed — same seed = same order */
function seededShuffle(arr, seed) {
  const random = seededRandom(seed);
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Generate a 4-digit game code */
function generateGameCode() {
  return Math.floor(1000 + Math.random() * 9000);
}

/** Show one screen, hide all others */
function showScreen(screenId) {
  document.querySelectorAll(".screen").forEach((s) => {
    s.classList.remove("active");
  });
  const target = document.getElementById(screenId);
  if (target) target.classList.add("active");
}

/** Get current location for the round */
function getCurrentLocation() {
  if (state.isDemoRound) return state.demoLocation;
  return state.locations[state.currentRound - 1];
}

/** Create round badge text */
function getRoundLabel() {
  if (state.isDemoRound) return "Demo Round";
  return `Round ${state.currentRound} of ${state.totalRounds}`;
}

/** Update all round badges */
function updateRoundBadges() {
  const label = getRoundLabel();
  const isDemo = state.isDemoRound;

  const badges = [
    "admin-round-badge",
    "admin-round-badge-active",
    "admin-reveal-badge",
    "player-pre-round-badge",
  ];

  badges.forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = label;
      el.className = `round-badge ${isDemo ? "demo" : "live"}`;
    }
  });

  const hudRound = document.getElementById("hud-round-info");
  if (hudRound) hudRound.textContent = label;
}

// ── Role Selection ──────────────────────────────────────────────

function selectRole(role) {
  state.role = role;
  if (role === "admin") {
    // Generate and display game code
    state.gameCode = generateGameCode();
    document.getElementById("admin-game-code").textContent = state.gameCode;
    showScreen("screen-admin-setup");
  } else {
    showScreen("screen-player-setup");
  }
}

function goBack() {
  state.role = null;
  showScreen("screen-role");
}

// ── Start Game ──────────────────────────────────────────────────

function startGame() {
  if (state.role === "admin") {
    state.totalRounds = clamp(
      parseInt(document.getElementById("admin-rounds").value) || 5,
      1,
      20
    );
    state.timerDuration = clamp(
      parseInt(document.getElementById("admin-timer").value) || 60,
      15,
      180
    );
    // gameCode already generated in selectRole
  } else {
    state.teamName =
      document.getElementById("player-team-name").value.trim() || "Team ?";
    state.gameCode = clamp(
      parseInt(document.getElementById("player-game-code").value) || 1000,
      1000,
      9999
    );
    state.totalRounds = clamp(
      parseInt(document.getElementById("player-rounds").value) || 5,
      1,
      20
    );
    state.timerDuration = clamp(
      parseInt(document.getElementById("player-timer").value) || 60,
      15,
      180
    );
  }

  // Prepare locations — use seeded shuffle so admin & players get same order
  state.demoLocation = LOCATIONS[0];
  const gamePool = seededShuffle(LOCATIONS.slice(1), state.gameCode);
  
  // Ensure alwaysInclude locations (like King's Landing) are always featured
  const mustInclude = gamePool.filter((l) => l.alwaysInclude);
  const others = gamePool.filter((l) => !l.alwaysInclude);
  const selected = [
    ...mustInclude.slice(0, state.totalRounds),
    ...others.slice(0, Math.max(0, state.totalRounds - mustInclude.length)),
  ];
  
  // Re-shuffle the selected subset deterministically so the always-include locations don't always occupy the first rounds
  state.locations = seededShuffle(selected, state.gameCode + 1);

  // Reset state
  state.currentRound = 0;
  state.isDemoRound = true;
  state.scores = [];
  state.totalScore = 0;
  state.currentGuess = null;
  state.guessLocked = false;
  state.roundActive = false;

  if (state.role === "admin") {
    showScreen("screen-admin-game");
    document.getElementById("admin-code-hud-value").textContent = state.gameCode;
    showAdminPhase("pre");
    updateRoundBadges();
  } else {
    showScreen("screen-player-game");
    initPlayerMap();
    document.getElementById("hud-team-name-text").textContent = state.teamName;
    document.getElementById("hud-total-score").textContent = "0";
    showPlayerPreOverlay();
    updateRoundBadges();
  }
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// ── Admin Phases ────────────────────────────────────────────────

function showAdminPhase(phase) {
  ["admin-phase-pre", "admin-phase-active", "admin-phase-timesup", "admin-phase-reveal"].forEach(
    (id) => {
      document.getElementById(id).style.display = "none";
    }
  );
  document.getElementById(`admin-phase-${phase}`).style.display = "";
}

/** Build free Google Street View embed URL (no API key needed) */
function getStreetViewUrl(lat, lng, heading) {
  return `https://maps.google.com/maps?layer=c&cbll=${lat},${lng}&cbp=11,${heading || 0},0,0,0&output=svembed`;
}

function adminStartRound() {
  const loc = getCurrentLocation();

  // Play theme audio if exists (admin only)
  playLocationAudio(loc);

  // Load Street View iframe
  const iframe = document.getElementById("admin-streetview");
  const svUrl = getStreetViewUrl(loc.lat, loc.lng, loc.heading);
  iframe.src = svUrl;

  // Reset admin hints panel
  resetAdminHints();

  // Show Street View wrapper, hide fallback
  document.querySelector(".streetview-wrapper").style.display = "";
  document.getElementById("admin-hint-fallback").style.display = "none";

  // Also populate fallback hint (in case Street View fails)
  document.getElementById("admin-category").textContent = loc.category;
  const diffEl = document.getElementById("admin-difficulty");
  diffEl.textContent = loc.difficulty;
  diffEl.className = `difficulty-badge ${loc.difficulty.toLowerCase()}`;
  document.getElementById("admin-hint-text").textContent = loc.hint;

  // Handle iframe load error — show fallback hint
  iframe.onerror = () => {
    document.querySelector(".streetview-wrapper").style.display = "none";
    document.getElementById("admin-hint-fallback").style.display = "";
  };

  // Setup timer
  state.timeLeft = state.timerDuration;
  updateAdminTimer();

  showAdminPhase("active");
  updateRoundBadges();

  // Start countdown
  state.roundActive = true;
  state.timerInterval = setInterval(() => {
    state.timeLeft--;
    updateAdminTimer();
    if (state.timeLeft <= 0) {
      clearInterval(state.timerInterval);
      state.roundActive = false;
      adminTimesUp();
    }
  }, 1000);
}

/** Force end the active round early (e.g. if all players guessed) */
function adminEndRound() {
  if (!state.roundActive) return;
  clearInterval(state.timerInterval);
  state.timerInterval = null;
  state.roundActive = false;
  adminTimesUp();
}

/** Show "Time's Up" screen with Reveal button */
function adminTimesUp() {
  stopLocationAudio();
  // Clear Street View iframe
  document.getElementById("admin-streetview").src = "about:blank";
  showAdminPhase("timesup");
}

function updateAdminTimer() {
  const num = document.getElementById("admin-timer-number");
  const circle = document.getElementById("admin-timer-circle");
  const progress = document.getElementById("admin-timer-progress");

  num.textContent = state.timeLeft;

  // Update circular progress
  const circumference = 2 * Math.PI * 72; // r=72
  const pct = state.timeLeft / state.timerDuration;
  progress.style.strokeDashoffset = circumference * (1 - pct);

  // Warning / danger classes
  circle.classList.remove("warning", "danger");
  if (state.timeLeft <= 5) {
    circle.classList.add("danger");
  } else if (state.timeLeft <= 15) {
    circle.classList.add("warning");
  }

  // Update admin hints based on elapsed time
  const loc = getCurrentLocation();
  if (!loc || !state.roundActive) return;

  const elapsedTime = state.timerDuration - state.timeLeft;

  // Hint 1: Native Greeting (30s)
  const h1Val = document.getElementById("admin-hint-1-value");
  const h1El = document.getElementById("admin-hint-1");
  if (elapsedTime >= 30) {
    if (h1Val.classList.contains("locked")) {
      h1Val.textContent = loc.greeting;
      h1Val.classList.remove("locked");
      h1El.classList.add("unlocked");
    }
  } else {
    h1Val.textContent = `🔒 Unlocks in ${30 - elapsedTime}s`;
    h1Val.classList.add("locked");
    h1El.classList.remove("unlocked");
  }

  // Hint 2: Country Flag (40s)
  const h2Val = document.getElementById("admin-hint-2-value");
  const h2El = document.getElementById("admin-hint-2");
  if (elapsedTime >= 40) {
    if (h2Val.classList.contains("locked")) {
      h2Val.innerHTML = `<img src="https://flagcdn.com/h40/${loc.countryCode}.png" alt="${loc.flag}" style="height: 24px; border-radius: 2px; vertical-align: middle; box-shadow: 0 1px 3px rgba(0,0,0,0.3);">`;
      h2Val.classList.remove("locked");
      h2El.classList.add("unlocked");
    }
  } else {
    h2Val.textContent = `🔒 Unlocks in ${40 - elapsedTime}s`;
    h2Val.classList.add("locked");
    h2El.classList.remove("unlocked");
  }

  // Hint 3: Place Name (50s)
  const h3Val = document.getElementById("admin-hint-3-value");
  const h3El = document.getElementById("admin-hint-3");
  if (elapsedTime >= 50) {
    if (h3Val.classList.contains("locked")) {
      h3Val.textContent = loc.placeShort;
      h3Val.classList.remove("locked");
      h3El.classList.add("unlocked");
    }
  } else {
    h3Val.textContent = `🔒 Unlocks in ${50 - elapsedTime}s`;
    h3Val.classList.add("locked");
    h3El.classList.remove("unlocked");
  }
}

function adminReveal() {
  const loc = getCurrentLocation();
  document.getElementById("admin-reveal-name").textContent = loc.name;
  updateRoundBadges();

  showAdminPhase("reveal");

  // Update "Next Round" button text
  const nextBtn = document.getElementById("btn-admin-next");
  if (!state.isDemoRound && state.currentRound >= state.totalRounds) {
    nextBtn.textContent = "🏁 Finish Game";
  } else if (state.isDemoRound) {
    nextBtn.textContent = "Start Round 1 →";
  } else {
    nextBtn.textContent = "Next Round →";
  }

  // Show map with correct pin
  setTimeout(() => {
    initAdminRevealMap(loc);
  }, 100);
}

function initAdminRevealMap(loc) {
  const container = document.getElementById("admin-reveal-map");

  // Destroy previous map if exists
  if (state.adminRevealMap) {
    state.adminRevealMap.remove();
    state.adminRevealMap = null;
  }

  state.adminRevealMap = L.map(container, {
    center: [loc.lat, loc.lng],
    zoom: 5,
    zoomControl: true,
    attributionControl: true,
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 20,
  }).addTo(state.adminRevealMap);

  // Correct marker
  const correctIcon = L.divIcon({
    className: "custom-marker correct",
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  L.marker([loc.lat, loc.lng], { icon: correctIcon })
    .addTo(state.adminRevealMap)
    .bindPopup(`<b>${loc.name}</b>`)
    .openPopup();
}

// ── Player Map ──────────────────────────────────────────────────

function initPlayerMap() {
  if (state.playerMap) {
    state.playerMap.remove();
    state.playerMap = null;
  }

  state.playerMap = L.map("player-map", {
    center: [20, 0],
    zoom: 2,
    minZoom: 2,
    maxZoom: 18,
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true,
  });

  // Base Layers
  const googleRoadmap = L.tileLayer("https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", {
    attribution: "© Google Maps",
    subdomains: ["mt0", "mt1", "mt2", "mt3"],
    maxZoom: 20,
  });

  const googleHybrid = L.tileLayer("https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
    attribution: "© Google Maps",
    subdomains: ["mt0", "mt1", "mt2", "mt3"],
    maxZoom: 20,
  });

  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  });

  // Default is Google Roadmap (familiar, highly readable, clear labels)
  googleRoadmap.addTo(state.playerMap);

  const baseMaps = {
    "🗺️ Google Roadmap": googleRoadmap,
    "🛰️ Google Satellite": googleHybrid,
    "📍 Detailed Streets (OSM)": osm,
  };

  // Add layer control
  L.control.layers(baseMaps, null, { position: "bottomright", collapsed: true }).addTo(state.playerMap);

  // Click to place marker
  state.playerMap.on("click", onMapClick);
}

function onMapClick(e) {
  if (!state.roundActive || state.guessLocked) return;

  state.currentGuess = { lat: e.latlng.lat, lng: e.latlng.lng };

  const guessIcon = L.divIcon({
    className: "custom-marker guess",
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  // Remove old marker
  if (state.guessMarker) {
    state.playerMap.removeLayer(state.guessMarker);
  }

  state.guessMarker = L.marker([e.latlng.lat, e.latlng.lng], {
    icon: guessIcon,
    draggable: true,
  }).addTo(state.playerMap);

  // Allow dragging to adjust
  state.guessMarker.on("dragend", (ev) => {
    const pos = ev.target.getLatLng();
    state.currentGuess = { lat: pos.lat, lng: pos.lng };
  });

  // Show lock-in button
  updatePlayerActions();
}

function updatePlayerActions() {
  const container = document.getElementById("player-actions");

  if (!state.roundActive) {
    container.innerHTML = "";
    return;
  }

  if (state.guessLocked) {
    container.innerHTML =
      '<div class="btn btn-outline" style="cursor:default;opacity:0.7;">✅ Guess Locked In</div>';
    return;
  }

  if (state.currentGuess) {
    container.innerHTML =
      '<button class="btn btn-gold btn-lg" onclick="lockGuess()">🔒 Lock In Guess</button>';
  } else {
    container.innerHTML =
      '<div class="btn btn-outline" style="cursor:default;opacity:0.7;">👆 Click the map to place your pin</div>';
  }
}

function lockGuess() {
  if (!state.currentGuess || state.guessLocked) return;
  state.guessLocked = true;

  // Make marker non-draggable
  if (state.guessMarker) {
    state.guessMarker.dragging.disable();
  }

  updatePlayerActions();
}

// ── Player Round ────────────────────────────────────────────────

function showPlayerPreOverlay() {
  document.getElementById("player-overlay-pre").classList.remove("hidden");
  document.getElementById("player-overlay-results").classList.add("hidden");

  const title = document.getElementById("player-pre-title");
  const desc = document.getElementById("player-pre-desc");

  if (state.isDemoRound) {
    title.textContent = "🎯 Demo Round";
    desc.textContent =
      "This is a practice round — points won't count. Wait for the host to show the hint, then press Start.";
  } else {
    title.textContent = `Round ${state.currentRound} of ${state.totalRounds}`;
    desc.textContent = "Wait for the host to show the hint, then press Start.";
  }

  updateRoundBadges();
}

function playerStartRound() {
  // Hide overlay
  document.getElementById("player-overlay-pre").classList.add("hidden");

  // Reset map state for this round
  clearMapMarkers();
  state.currentGuess = null;
  state.guessLocked = false;
  state.roundActive = true;

  // Don't play audio for players (only admin plays it)
  // const loc = getCurrentLocation();
  // playLocationAudio(loc);

  // Reset map view
  state.playerMap.setView([20, 0], 2);

  // Start timer
  state.timeLeft = state.timerDuration;
  updatePlayerTimer();
  updatePlayerActions();

  state.timerInterval = setInterval(() => {
    state.timeLeft--;
    updatePlayerTimer();
    if (state.timeLeft <= 0) {
      clearInterval(state.timerInterval);
      endPlayerRound();
    }
  }, 1000);
}

function updatePlayerTimer() {
  const el = document.getElementById("hud-timer");
  el.textContent = state.timeLeft;

  el.classList.remove("warning", "danger");
  if (state.timeLeft <= 5) {
    el.classList.add("danger");
  } else if (state.timeLeft <= 15) {
    el.classList.add("warning");
  }
}

function endPlayerRound() {
  stopLocationAudio();
  state.roundActive = false;
  updatePlayerActions();

  const loc = getCurrentLocation();
  let distance = 0;
  let points = 0;

  if (state.currentGuess) {
    distance = haversineDistance(
      state.currentGuess.lat,
      state.currentGuess.lng,
      loc.lat,
      loc.lng
    );
    points = calculateScore(distance);
  }

  // Only add score if not demo round
  if (!state.isDemoRound) {
    state.scores.push({
      round: state.currentRound,
      distance,
      points,
      locationName: loc.name,
    });
    state.totalScore += points;
  }

  // Show correct marker & line on map
  showCorrectOnMap(loc, distance);

  // Show results overlay
  showPlayerResults(loc, distance, points);
}

function showCorrectOnMap(loc, distance) {
  const correctIcon = L.divIcon({
    className: "custom-marker correct",
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });

  state.correctMarker = L.marker([loc.lat, loc.lng], { icon: correctIcon })
    .addTo(state.playerMap)
    .bindPopup(`<b>${loc.name}</b>`)
    .openPopup();

  if (state.currentGuess) {
    // Draw line between guess and correct
    state.distanceLine = L.polyline(
      [
        [state.currentGuess.lat, state.currentGuess.lng],
        [loc.lat, loc.lng],
      ],
      {
        color: "#f59e0b",
        weight: 2,
        dashArray: "8, 8",
        opacity: 0.8,
      }
    ).addTo(state.playerMap);

    // Fit bounds to show both markers
    const bounds = L.latLngBounds(
      [state.currentGuess.lat, state.currentGuess.lng],
      [loc.lat, loc.lng]
    );
    state.playerMap.fitBounds(bounds, { padding: [60, 60] });
  } else {
    // No guess — just zoom to correct location
    state.playerMap.setView([loc.lat, loc.lng], 5);
  }
}

function showPlayerResults(loc, distance, points) {
  document.getElementById("player-result-location").textContent = loc.name;
  document.getElementById("player-result-distance").textContent =
    state.currentGuess ? formatDistance(distance) : "No guess";
  document.getElementById("player-result-points").textContent =
    state.currentGuess ? points.toLocaleString() : "0";
  document.getElementById("player-result-total").textContent =
    state.totalScore.toLocaleString();
  document.getElementById("hud-total-score").textContent =
    state.totalScore.toLocaleString();

  // Demo notice
  const demoNotice = document.getElementById("player-demo-notice");
  demoNotice.style.display = state.isDemoRound ? "" : "none";

  // Button text
  const nextBtn = document.getElementById("btn-player-next");
  if (!state.isDemoRound && state.currentRound >= state.totalRounds) {
    nextBtn.textContent = "🏁 See Final Score";
  } else if (state.isDemoRound) {
    nextBtn.textContent = "Start Round 1 →";
  } else {
    nextBtn.textContent = "Ready for Next Round →";
  }

  document.getElementById("player-overlay-results").classList.remove("hidden");

  // Confetti for great scores
  if (points >= 4500 && state.currentGuess) {
    launchConfetti();
  }
}

function clearMapMarkers() {
  if (state.guessMarker) {
    state.playerMap.removeLayer(state.guessMarker);
    state.guessMarker = null;
  }
  if (state.correctMarker) {
    state.playerMap.removeLayer(state.correctMarker);
    state.correctMarker = null;
  }
  if (state.distanceLine) {
    state.playerMap.removeLayer(state.distanceLine);
    state.distanceLine = null;
  }
}

// ── Next Round / Game Over ──────────────────────────────────────

function nextRound() {
  stopLocationAudio();
  // Clear any running timer
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }

  if (state.isDemoRound) {
    // Move from demo to round 1
    state.isDemoRound = false;
    state.currentRound = 1;
  } else {
    state.currentRound++;
  }

  // Check if game is over
  if (state.currentRound > state.totalRounds) {
    gameOver();
    return;
  }

  // Setup next round
  if (state.role === "admin") {
    showAdminPhase("pre");
    updateRoundBadges();
  } else {
    showPlayerPreOverlay();
    clearMapMarkers();
    state.currentGuess = null;
    state.guessLocked = false;
    state.playerMap.setView([20, 0], 2);
  }
}

function gameOver() {
  if (state.role === "admin") {
    showScreen("screen-admin-gameover");
  } else {
    showScreen("screen-player-gameover");
    renderPlayerGameOver();
  }
  launchConfetti();
}

function renderPlayerGameOver() {
  document.getElementById("gameover-team-label").textContent = state.teamName;
  document.getElementById("gameover-final-score").textContent =
    state.totalScore.toLocaleString();

  const breakdown = document.getElementById("gameover-breakdown");
  // Clear previous rows (keep h3)
  const h3 = breakdown.querySelector("h3");
  breakdown.innerHTML = "";
  breakdown.appendChild(h3);

  state.scores.forEach((s) => {
    const row = document.createElement("div");
    row.className = "breakdown-row";
    row.innerHTML = `
      <span class="round-label">Round ${s.round}: ${s.locationName}</span>
      <span class="round-distance">${formatDistance(s.distance)}</span>
      <span class="round-points">${s.points.toLocaleString()} pts</span>
    `;
    breakdown.appendChild(row);
  });
}

function playAgain() {
  // Full reset
  state.role = null;
  state.scores = [];
  state.totalScore = 0;
  state.currentRound = 0;
  state.isDemoRound = true;
  state.currentGuess = null;
  state.guessLocked = false;
  state.roundActive = false;

  stopLocationAudio();

  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  if (state.playerMap) {
    state.playerMap.remove();
    state.playerMap = null;
  }
  if (state.adminRevealMap) {
    state.adminRevealMap.remove();
    state.adminRevealMap = null;
  }

  showScreen("screen-role");
}

// ── Confetti ────────────────────────────────────────────────────

function launchConfetti() {
  const canvas = document.getElementById("confetti-canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = [];
  const colors = [
    "#7c3aed",
    "#06b6d4",
    "#f59e0b",
    "#10b981",
    "#ec4899",
    "#f97316",
    "#6366f1",
  ];

  for (let i = 0; i < 120; i++) {
    particles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: Math.random() * 10 + 5,
      h: Math.random() * 6 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      vx: (Math.random() - 0.5) * 4,
      vy: Math.random() * 3 + 2,
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 10,
      opacity: 1,
    });
  }

  let frame = 0;
  const maxFrames = 180; // ~3 seconds at 60fps

  function animate() {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05; // gravity
      p.rotation += p.rotationSpeed;

      if (frame > maxFrames - 60) {
        p.opacity = Math.max(0, p.opacity - 0.02);
      }

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });

    if (frame < maxFrames) {
      requestAnimationFrame(animate);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  animate();
}

// ── Window resize handler for maps ──────────────────────────────
window.addEventListener("resize", () => {
  if (state.playerMap) state.playerMap.invalidateSize();
  if (state.adminRevealMap) state.adminRevealMap.invalidateSize();

  // Resize confetti canvas
  const canvas = document.getElementById("confetti-canvas");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
});

// ── Dynamic Hints Helpers ───────────────────────────────────────

function resetAdminHints() {
  const h1Val = document.getElementById("admin-hint-1-value");
  const h1El = document.getElementById("admin-hint-1");
  if (h1Val && h1El) {
    h1Val.textContent = "🔒 Unlocks in 30s";
    h1Val.className = "hint-value locked";
    h1El.className = "hint-item";
  }

  const h2Val = document.getElementById("admin-hint-2-value");
  const h2El = document.getElementById("admin-hint-2");
  if (h2Val && h2El) {
    h2Val.textContent = "🔒 Unlocks in 40s";
    h2Val.className = "hint-value locked";
    h2El.className = "hint-item";
  }

  const h3Val = document.getElementById("admin-hint-3-value");
  const h3El = document.getElementById("admin-hint-3");
  if (h3Val && h3El) {
    h3Val.textContent = "🔒 Unlocks in 50s";
    h3Val.className = "hint-value locked";
    h3El.className = "hint-item";
  }

  const hintsCard = document.getElementById("admin-hints-card");
  if (hintsCard) {
    hintsCard.classList.add("collapsed-mobile");
    const toggleIcon = document.getElementById("admin-hints-toggle-icon");
    if (toggleIcon) toggleIcon.textContent = "▼";
  }
}

function toggleAdminHints() {
  const hintsCard = document.getElementById("admin-hints-card");
  if (!hintsCard) return;
  const isCollapsed = hintsCard.classList.toggle("collapsed-mobile");
  const toggleIcon = document.getElementById("admin-hints-toggle-icon");
  if (toggleIcon) {
    toggleIcon.textContent = isCollapsed ? "▼" : "▲";
  }
}

// ── Audio Player Helpers ─────────────────────────────────────────

let currentAudio = null;

function playLocationAudio(loc) {
  stopLocationAudio();

  if (!loc || !loc.audioUrl) return;

  currentAudio = new Audio(loc.audioUrl);
  currentAudio.volume = 0.5;
  currentAudio.play().catch((err) => {
    console.warn("Audio playback blocked by browser policy or file not found:", err);
  });
}

function stopLocationAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}
