(() => {
  "use strict";

  if (window.frameLiveInstalled) return;
  window.frameLiveInstalled = true;

  const API = "https://frame-api.m-ozarovskis.workers.dev";
  const IMAGE = "https://image.tmdb.org/t/p/w780";
  const PREFIX = "frame-live-v1-";

  const feed = document.getElementById("feed");
  const grid = document.getElementById("grid");
  const search = document.getElementById("search");

  function read(name, fallback) {
    try {
      return JSON.parse(localStorage.getItem(PREFIX + name)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  let storageWarningShown = false;

  function write(name, value) {
    try {
      localStorage.setItem(PREFIX + name, JSON.stringify(value));
    } catch {
      if (!storageWarningShown) {
        storageWarningShown = true;
        toast("Browser storage is full or unavailable. History may not persist.");
      }
    }
  }

  const seen = new Set(read("seen", []));
  const cursors = read("cursors", {});
  const bank = new Map();
  const states = new Map();
  const detailRequests = new Map();

  let genreList = [];
  let ready = false;
  let starting = false;
  let startError = "";
  let activeState = null;
  let displayedState = null;
  let displayedView = "";
  let seenTimer;
  let searchTimer;
  let detailsVersion = 0;

  const oldSaveMovie = saveMovie;

  const style = document.createElement("style");
  style.textContent = `
    .live-end {
      padding: 45px 22px;
      text-align: center;
      color: #aaa;
      line-height: 1.7;
      grid-column: 1 / -1;
    }
    #feed > .live-end {
      min-height: 170px;
      scroll-snap-align: start;
      background: #080808;
    }
    .live-end button {
      padding: 12px 20px;
      margin-top: 12px;
      border: 1px solid #666;
      border-radius: 24px;
      color: white;
    }
    .tmdb-score {
      padding: 3px 5px;
      border-radius: 3px;
      background: #90cea1;
      color: #102820;
      font: 800 9px Arial, sans-serif;
    }
    .live-credit {
      color: #999;
      font-size: 10px;
      line-height: 1.7;
      margin-top: 22px;
    }
  `;
  document.head.appendChild(style);

  function titleKey(movie) {
    return String(movie.title || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "") +
      ":" + String(movie.year || "");
  }

  function identityKeys(movie) {
    const keys = [titleKey(movie)];

    if (movie.tmdbId) keys.push("tmdb:" + movie.tmdbId);

    if (movie.originalTitle) {
      keys.push(titleKey({
        title: movie.originalTitle,
        year: movie.year
      }));
    }

    return keys;
  }

  function wasSeen(movie) {
    return identityKeys(movie).some(key => seen.has(key));
  }

  function watchedKeys() {
    const result = new Set();

    for (const id of savedMovies) {
      const movie = bank.get(id);
      if (movie) identityKeys(movie).forEach(key => result.add(key));
    }

    return result;
  }

  function isSavedMovie(movie) {
    if (savedMovies.has(movie.id)) return true;
    const keys = watchedKeys();
    return identityKeys(movie).some(key => keys.has(key));
  }

  function persistSavedRecords() {
    write(
      "saved-records",
      [...savedMovies].map(id => bank.get(id)).filter(Boolean)
    );
  }

  function register(movie) {
    const existing = bank.get(movie.id);

    if (existing) {
      // Do not replace fetched runtime/cast with a lightweight listing.
      if (!existing.loaded || movie.loaded) Object.assign(existing, movie);
      return existing;
    }

    bank.set(movie.id, movie);
    movies.push(movie);
    return movie;
  }

  function normalizeMovie(data, full = false) {
    const genres = data.genres
      ? data.genres.map(genre => genre.name)
      : (data.genre_ids || [])
          .map(id => genreList.find(genre => genre.id === id)?.name)
          .filter(Boolean);

    return {
      id: -Number(data.id),
      tmdbId: Number(data.id),
      title: data.title || data.original_title || "Untitled",
      originalTitle: data.original_title || "",
      year: (data.release_date || "").slice(0, 4),
      releaseDate: data.release_date || null,
      runtime: full && data.runtime > 0 ? data.runtime : null,
      rating: data.vote_count > 0 ? Number(data.vote_average) : null,
      ratingSource: "TMDB",
      votes: Number(data.vote_count || 0),
      genres,
      director: (data.credits?.crew || [])
        .filter(person => person.job === "Director")
        .map(person => person.name)
        .join(", "),
      cast: (data.credits?.cast || []).slice(0, 6).map(person => person.name),
      overview: data.overview || "A synopsis is not available yet.",
      poster: data.poster_path ? IMAGE + data.poster_path : PLACEHOLDER,
      posterOriginal: data.poster_path
        ? "https://image.tmdb.org/t/p/w500" + data.poster_path
        : "",
      hasPoster: Boolean(data.poster_path),
      imdbId: data.imdb_id || data.external_ids?.imdb_id || null,
      loaded: full
    };
  }

  async function api(path, parameters = {}) {
    const url = new URL(API + path);

    for (const [key, value] of Object.entries(parameters)) {
      if (value !== null && value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: "omit"
      });

      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error("The movie service returned an unexpected response.");
      }

      if (!response.ok) {
        throw new Error(data.error || "Could not load movies.");
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("The movie service took too long. Please retry.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fullMovie(movie) {
    if (!movie.tmdbId || movie.loaded) return movie;

    if (!detailRequests.has(movie.tmdbId)) {
      const promise = api("/movie/" + movie.tmdbId)
        .then(data => {
          const updated = register(normalizeMovie(data, true));
          if (savedMovies.has(updated.id)) persistSavedRecords();
          return updated;
        })
        .finally(() => detailRequests.delete(movie.tmdbId));

      detailRequests.set(movie.tmdbId, promise);
    }

    return detailRequests.get(movie.tmdbId);
  }

  function normalizedGenre(name) {
    return name === "Sci-Fi" ? "Science Fiction" : name;
  }

  function preferenceWeights() {
    const weights = new Map();

    for (const id of savedMovies) {
      const movie = bank.get(id);
      if (!movie) continue;

      for (const original of movie.genres || []) {
        const genre = normalizedGenre(original);
        weights.set(genre, (weights.get(genre) || 0) + 1);
      }
    }

    return weights;
  }

  function preferredGenreIds() {
    return [...preferenceWeights()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => genreList.find(genre => genre.name === name)?.id)
      .filter(Boolean);
  }

  function tasteScore(movie) {
    const weights = preferenceWeights();
    const total = [...weights.values()].reduce((sum, value) => sum + value, 0);

    const affinity = (movie.genres || []).reduce(
      (sum, genre) => sum + (weights.get(normalizedGenre(genre)) || 0),
      0
    ) / Math.max(1, total);

    const quality = Number.isFinite(movie.rating) ? movie.rating / 10 : 0.4;
    const confidence = Math.min(1, Math.log10((movie.votes || 0) + 1) / 4);

    return affinity * 5 + quality + confidence * 0.3;
  }

  function rankMix(items) {
    // Alternate between preference matches and broader discoveries.
    const preferred = [...items].sort((a, b) => tasteScore(b) - tasteScore(a));
    const varied = [...items].sort(() => Math.random() - 0.5);
    const result = [];
    const used = new Set();

    while (result.length < items.length) {
      const source = result.length % 4 === 3 ? varied : preferred;
      let candidate;

      while (source.length && !candidate) {
        const next = source.shift();
        if (!used.has(next.id)) candidate = next;
      }

      if (!candidate) {
        candidate = items.find(movie => !used.has(movie.id));
      }

      if (!candidate) break;
      used.add(candidate.id);
      result.push(candidate);
    }

    return result;
  }

  function filtersForRequest() {
    const genreIds = appliedFilters.genres
      .map(normalizedGenre)
      .map(name => genreList.find(genre => genre.name === name)?.id)
      .filter(Boolean);

    return {
      "with_genres": genreIds.join("|") || undefined,
      "vote_average.gte": appliedFilters.rating || undefined,
      "vote_count.gte": appliedFilters.rating > 0 ? 20 : undefined,
      "with_runtime.lte":
        appliedFilters.runtime === 999 ? undefined : appliedFilters.runtime,
      "with_runtime.gte":
        appliedFilters.runtime === 999 ? undefined : 1,
      "primary_release_date.gte": appliedFilters.yearFrom
        ? appliedFilters.yearFrom + "-01-01"
        : undefined,
      "primary_release_date.lte": appliedFilters.yearTo
        ? appliedFilters.yearTo + "-12-31"
        : undefined
    };
  }

  function buildSources(currentMode, query) {
    if (query) return [{ path: "/search", params: { query } }];

    const base = filtersForRequest();
    const today = localDateISO();

    if (currentMode === "upcoming") {
      const tomorrow = new Date(today + "T12:00:00Z");
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const lower = tomorrow.toISOString().slice(0, 10);

      return [{
        path: "/discover",
        params: {
          ...base,
          "primary_release_date.gte":
            base["primary_release_date.gte"] > lower
              ? base["primary_release_date.gte"]
              : lower,
          sort_by: "primary_release_date.asc"
        }
      }];
    }

    base["primary_release_date.lte"] =
      base["primary_release_date.lte"] &&
      base["primary_release_date.lte"] < today
        ? base["primary_release_date.lte"]
        : today;

    if (currentMode === "new") {
      return [{
        path: "/discover",
        params: { ...base, sort_by: "primary_release_date.desc" }
      }];
    }

    if (currentMode === "rated") {
      return [{
        path: "/discover",
        params: {
          ...base,
          "vote_count.gte": 200,
          sort_by: "vote_average.desc"
        }
      }];
    }

    const sources = [
      { path: "/discover", params: { ...base, sort_by: "popularity.desc" } },
      { path: "/discover", params: { ...base, sort_by: "vote_count.desc" } }
    ];

    const preferred = preferredGenreIds();

    if (preferred.length && !base.with_genres) {
      sources.unshift({
        path: "/discover",
        params: {
          ...base,
          with_genres: preferred.join("|"),
          sort_by: "popularity.desc"
        }
      });
    }

    // Separate year searches reach beyond the first broad result pages.
    const firstYear = appliedFilters.yearFrom || 1900;
    const lastYear = Math.min(
      appliedFilters.yearTo || new Date().getFullYear(),
      new Date().getFullYear()
    );

    const years = [];
    for (let year = firstYear; year <= lastYear; year++) years.push(year);

    for (let index = years.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [years[index], years[other]] = [years[other], years[index]];
    }

    for (const year of years) {
      sources.push({
        path: "/discover",
        params: {
          ...base,
          primary_release_year: year,
          sort_by: "popularity.desc"
        }
      });
    }

    return sources;
  }

  function createState() {
    const query = view === "explore" ? search.value.trim() : "";
    const key = JSON.stringify([view, mode, appliedFilters, query]);

    if (states.has(key)) return states.get(key);

    const state = {
      key,
      view,
      mode,
      query,
      items: [],
      keys: new Set(),
      anchor: null,
      gridTop: 0,
      busy: false,
      error: "",
      more: view !== "watchlist",
      sources: view === "watchlist" ? [] : buildSources(mode, query),
      sourceIndex: 0
    };

    states.set(key, state);
    return state;
  }

  function sourceKey(source) {
    const pairs = Object.entries(source.params)
      .filter(([, value]) => value !== undefined)
      .sort((a, b) => a[0].localeCompare(b[0]));

    return JSON.stringify([source.path, pairs]);
  }

  function nextSource(state) {
    for (let count = 0; count < state.sources.length; count++) {
      const source = state.sources[state.sourceIndex % state.sources.length];
      state.sourceIndex++;

      const key = sourceKey(source);

      // Search and sorted screens start at page one in a new session.
      const persistent = state.view === "feed" && state.mode === "picks";
      const cursor = persistent
        ? (cursors[key] || { page: 1, done: false })
        : (source.cursor || { page: 1, done: false });

      if (!cursor.done) return { source, key, cursor, persistent };
    }

    return null;
  }

  function rememberPosition() {
    if (!displayedState) return;

    if (displayedView === "feed") {
      const cards = [...feed.querySelectorAll(".movie")];
      const current = cards.reduce((nearest, card) => {
        if (!nearest) return card;

        return Math.abs(card.offsetTop - feed.scrollTop) <
          Math.abs(nearest.offsetTop - feed.scrollTop)
            ? card
            : nearest;
      }, null);

      if (current) displayedState.anchor = Number(current.dataset.id);
    } else {
      displayedState.gridTop = grid.scrollTop;
    }
  }

  function scheduleSeen() {
    clearTimeout(seenTimer);

    if (view !== "feed" || !activeState || document.hidden) return;

    seenTimer = setTimeout(() => {
      if (view !== "feed" || document.hidden) return;

      const bounds = feed.getBoundingClientRect();
      const cards = [...feed.querySelectorAll(".movie")];

      const card = cards.find(element => {
        const rect = element.getBoundingClientRect();
        const visible = Math.max(
          0,
          Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top)
        );
        return visible >= bounds.height * 0.65;
      });

      if (!card) return;

      const movie = bank.get(Number(card.dataset.id));
      if (!movie) return;

      identityKeys(movie).forEach(key => seen.add(key));
      write("seen", [...seen]);

      activeState.anchor = movie.id;
      hydrateVisible(movie.id);
    }, 1000);
  }

  async function hydrateVisible(id) {
    const movie = bank.get(id);
    if (!movie || movie.loaded || !movie.tmdbId) return;

    try {
      const updated = await fullMovie(movie);

      feed.querySelectorAll(`.movie[data-id="${id}"] .metadata`)
        .forEach(element => {
          element.outerHTML = movieMetadata(updated);
        });
    } catch {
      // Details can be retried when the user opens the movie.
    }
  }

  function endMarkup(state) {
    const message = state.busy
      ? "Finding more films…"
      : state.error
        ? state.error
        : state.more
          ? "Keep discovering."
          : state.view === "watchlist"
            ? "Your saved films are kept here."
            : "You’ve reached the end of this selection. Try another mix or broader filters.";

    return `
      <div class="live-end">
        ${escapeHTML(message)}
        ${!state.busy && (state.more || state.error)
          ? '<br><button data-live-more>Load more films</button>'
          : ""}
      </div>
    `;
  }

  function paint(state) {
    if (state !== activeState) return;

    rememberPosition();

    const target = view === "feed" ? feed : grid;
    const previousBehavior = target.style.scrollBehavior;
    target.style.scrollBehavior = "auto";

    target.innerHTML = state.items.map((movie, index) =>
      view === "feed" ? movieCard(movie, index) : movieTile(movie)
    ).join("") + endMarkup(state);

    filteredMovies = state.items;
    renderedCount = state.items.length;

    if (view === "feed") {
      const anchor = state.anchor == null
        ? null
        : feed.querySelector(`.movie[data-id="${state.anchor}"]`);

      if (anchor) feed.scrollTop = anchor.offsetTop;
    } else {
      grid.scrollTop = state.gridTop;
    }

    target.style.scrollBehavior = previousBehavior;
    displayedState = state;
    displayedView = view;

    scheduleSeen();
  }

  function updateEnd(state) {
    if (state !== activeState) return;
    const target = view === "feed" ? feed : grid;
    const previous = target.querySelector(".live-end");

    if (previous) previous.outerHTML = endMarkup(state);
    else target.insertAdjacentHTML("beforeend", endMarkup(state));
  }

  function localFilter(movie) {
    if (
      appliedFilters.genres.length &&
      !movie.genres.some(genre =>
        appliedFilters.genres.map(normalizedGenre).includes(genre)
      )
    ) return false;

    if (
      appliedFilters.rating > 0 &&
      (!Number.isFinite(movie.rating) || movie.rating < appliedFilters.rating)
    ) return false;

    const year = Number(movie.year);
    if (appliedFilters.yearFrom && year < appliedFilters.yearFrom) return false;
    if (appliedFilters.yearTo && year > appliedFilters.yearTo) return false;

    if (
      (appliedFilters.yearFrom || appliedFilters.yearTo) &&
      !movie.year
    ) return false;

    return true;
  }

  async function loadMore(state) {
    if (!ready || state.busy || !state.more) return;

    state.busy = true;
    state.error = "";
    updateEnd(state);

    try {
      // Bound each loading operation so restrictive filters cannot
      // cause an endless burst of requests.
      let added = 0;

      for (let attempt = 0; attempt < 5 && added < 12; attempt++) {
        const next = nextSource(state);

        if (!next) {
          state.more = false;
          break;
        }

        const { source, key, cursor, persistent } = next;
        const page = cursor.page;
        const data = await api(source.path, { ...source.params, page });
        const incoming = [];

        for (const raw of data.results || []) {
          if (raw.adult || !raw.poster_path) continue;

          let movie = register(normalizeMovie(raw));
          if (state.keys.has(movie.id)) continue;
          if (!localFilter(movie)) continue;

          if (state.view === "feed") {
            if (isSavedMovie(movie) || wasSeen(movie)) continue;
          }

          // Search does not support the discovery runtime filter.
          if (state.query && appliedFilters.runtime !== 999) {
            movie = await fullMovie(movie);
            if (!movie.runtime || movie.runtime > appliedFilters.runtime) continue;
          }

          // Deduplicate aliases within the current queue.
          const aliases = identityKeys(movie);
          if (aliases.some(alias => state.keys.has(alias))) continue;

          state.keys.add(movie.id);
          aliases.forEach(alias => state.keys.add(alias));
          incoming.push(movie);
        }

        const nextCursor = {
          page: page + 1,
          done: page >= Math.min(Number(data.total_pages || 0), 500)
        };

        if (persistent) {
          cursors[key] = nextCursor;
          write("cursors", cursors);
        } else {
          source.cursor = nextCursor;
        }

        const ordered = state.mode === "picks" && !state.query
          ? rankMix(incoming)
          : incoming;

        state.items.push(...ordered);
        added += ordered.length;
      }

      paint(state);
    } catch (error) {
      state.error = error.message || "Could not load movies. Please retry.";
    } finally {
      state.busy = false;
      updateEnd(state);
    }
  }

  function setupFilters() {
    yearBounds = {
      min: 1870,
      max: new Date().getFullYear() + 3
    };

    for (const selector of ["#year-from", "#year-to"]) {
      $(selector).min = yearBounds.min;
      $(selector).max = yearBounds.max;
    }

    $("#minimum-year-label").textContent = yearBounds.min;
    $("#maximum-year-label").textContent = yearBounds.max;

    appliedFilters.genres = appliedFilters.genres
      .map(normalizedGenre)
      .filter(name => genreList.some(genre => genre.name === name));

    $("#genres").innerHTML = genreList.map(genre => `
      <button data-genre="${escapeHTML(genre.name)}" aria-pressed="false">
        ${escapeHTML(genre.name)}
      </button>
    `).join("");

    $$("#genres button").forEach(button => {
      button.onclick = () => {
        const genre = button.dataset.genre;

        if (selectedGenres.has(genre)) selectedGenres.delete(genre);
        else selectedGenres.add(genre);

        button.classList.toggle("selected", selectedGenres.has(genre));
        button.setAttribute("aria-pressed", String(selectedGenres.has(genre)));
      };
    });

    document.querySelector('label[for="rating-filter"] span').textContent =
      "Minimum TMDB rating";

    $("#rating-filter").setAttribute("aria-label", "Minimum TMDB rating");

    search.placeholder = "Search movie titles";
    syncFilters();
  }

  async function start() {
    if (starting || ready || !movies.length) return;

    starting = true;
    startError = "";

    // Retain the old catalog so existing watchlist IDs still work.
    movies.forEach(movie => bank.set(movie.id, movie));

    for (const movie of read("saved-records", [])) {
      if (movie && Number.isFinite(movie.id)) register(movie);
    }

    feed.innerHTML =
      '<div class="empty"><h2>Connecting to a bigger world of cinema.</h2></div>';

    try {
      const data = await api("/genres");
      genreList = data.genres || [];

      if (!genreList.length) throw new Error("The genre list could not load.");

      setupFilters();
      persistSavedRecords();
      ready = true;

      render();

      const shared = location.hash.match(/^#movie=(-?\d+)$/);
      if (shared) openDetails(Number(shared[1]));
    } catch (error) {
      startError = error.message;
      feed.innerHTML = `
        <div class="empty">
          <h2>Couldn’t connect yet.</h2>
          <p>${escapeHTML(startError)}</p>
          <button data-live-retry>Retry connection</button>
        </div>
      `;
    } finally {
      starting = false;
    }
  }

  // Replace the old renderer and its position-fix wrapper.
  render = function () {
    if (!ready) {
      start();
      return;
    }

    rememberPosition();
    clearTimeout(seenTimer);
    paginationObserver?.disconnect();

    document.body.dataset.view = view;
    feed.hidden = view !== "feed";
    grid.hidden = view === "feed";
    $("#search-wrapper").hidden = view === "feed";

    $("#page-title").textContent = {
      feed: "For you",
      explore: "Explore",
      watchlist: "Your watchlist"
    }[view];

    $("#release-note").hidden = true;

    $$(".nav-button").forEach(button => {
      button.classList.toggle("active", button.dataset.view === view);
    });

    $$("[data-mode]").forEach(button => {
      button.classList.toggle("active", button.dataset.mode === mode);
    });

    $("#saved-count").textContent = savedMovies.size;

    const state = createState();

    if (view === "watchlist") {
      const query = search.value.trim().toLowerCase();

      state.items = [...savedMovies]
        .map(id => bank.get(id))
        .filter(Boolean)
        .filter(movie => !query || [
          movie.title, movie.director, ...movie.genres, ...movie.cast
        ].join(" ").toLowerCase().includes(query));

      state.more = false;
    } else if (view === "feed") {
      // A saved movie disappears when returning to the feed.
      // Saving the visible card itself does not abruptly move the screen.
      state.items = state.items.filter(movie => !isSavedMovie(movie));

      if (!state.items.some(movie => movie.id === state.anchor)) {
        state.anchor = state.items[0]?.id ?? null;
      }
    }

    activeState = state;
    displayedState = null;
    paint(state);

    if (!state.items.length && state.more) loadMore(state);
  };

  appendBatch = function () {
    if (activeState) loadMore(activeState);
  };

  shuffleCatalog = function () {
    rememberPosition();
    states.clear();
    activeState = null;
    displayedState = null;
    // Deliberately preserve history and source page cursors.
  };

  movieMetadata = function (movie) {
    const tmdb = movie.ratingSource === "TMDB";
    const runtime = movie.tmdbId && !movie.loaded
      ? "Runtime loading…"
      : minutesLabel(movie.runtime);

    return `
      <div class="metadata">
        <span class="${tmdb ? "tmdb-score" : "imdb"}">
          ${tmdb ? "TMDB" : "IMDb"}
        </span>
        <strong class="rating">${ratingLabel(movie)}</strong>
        ${Number.isFinite(movie.rating)
          ? '<span class="out-of">/ 10</span>' : ""}
        <span class="movie-year">${escapeHTML(movie.year || "TBA")}</span>
        <span class="runtime">${icon("clock")}${runtime}</span>
      </div>
    `;
  };

  movieTile = function (movie) {
    return `
      <button class="movie-tile" data-details="${movie.id}">
        <img ${posterAttributes(movie)}
          alt="${escapeHTML(movie.title)} poster" loading="lazy">
        <strong>${escapeHTML(movie.title)}</strong>
        <small>
          ${movie.ratingSource === "TMDB" ? "TMDB" : "IMDb"}
          ${ratingLabel(movie)} · ${escapeHTML(movie.year || "TBA")}
          ${movie.runtime ? " · " + minutesLabel(movie.runtime) : ""}
        </small>
      </button>
    `;
  };

  releaseLabel = function (movie) {
    if (!movie.tmdbId) return movie.director || "";

    if (!movie.releaseDate) return "Release date TBA";

    const date = new Date(movie.releaseDate + "T12:00:00")
      .toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric"
      });

    return `${isUpcoming(movie) ? "Coming" : "Released"} ${date}`;
  };

  saveMovie = function (id, forceSave = false) {
    oldSaveMovie(id, forceSave);
    persistSavedRecords();

    // Remove saved titles from other queued feeds, but leave the
    // currently displayed card in place until the user moves on.
    for (const state of states.values()) {
      if (state.view !== "feed" || state === activeState) continue;
      state.items = state.items.filter(movie => !isSavedMovie(movie));
    }
  };

  openDetails = async function (id) {
    const version = ++detailsVersion;
    let movie = bank.get(id);

    $("#details-content").innerHTML =
      '<div class="details-body">Loading movie details…</div>';

    if (!$("#details-dialog").open) $("#details-dialog").showModal();

    try {
      if (!movie && id < 0) {
        movie = register(normalizeMovie(await api("/movie/" + (-id)), true));
      } else if (movie) {
        movie = await fullMovie(movie);
      }

      if (!movie) throw new Error("This movie is not available.");

      if (version !== detailsVersion || !$("#details-dialog").open) return;

      const imdbURL = movie.imdbId
        ? "https://www.imdb.com/title/" + movie.imdbId + "/"
        : "https://www.imdb.com/find/?q=" + encodeURIComponent(movie.title);

      $("#details-content").innerHTML = `
        <div class="details-top">
          <img class="details-poster" ${posterAttributes(movie)}
            alt="${escapeHTML(movie.title)} poster">
          <div>
            <div class="eyebrow">${escapeHTML(movie.genres.join(" · "))}</div>
            <h2>${escapeHTML(movie.title)}</h2>
            ${movieMetadata(movie)}
          </div>
        </div>
        <div class="details-body">
          <p>${escapeHTML(movie.overview)}</p>
          <p><strong>Directed by</strong><br>
            ${escapeHTML(movie.director || "Not available")}</p>
          <p><strong>Starring</strong><br>
            ${escapeHTML(movie.cast.join(" · ") || "Not available")}</p>
          <p><small>
            ${movie.tmdbId
              ? "Rating from TMDB. Release dates may vary by country."
              : "Historical IMDb rating from your original catalog."}
          </small></p>
          <div class="film-links">
            <a href="${escapeHTML(imdbURL)}" target="_blank"
              rel="noopener noreferrer">IMDb</a>
            <a href="https://letterboxd.com/search/films/${encodeURIComponent(movie.title)}/"
              target="_blank" rel="noopener noreferrer">Letterboxd</a>
            ${movie.tmdbId
              ? `<a href="https://www.themoviedb.org/movie/${movie.tmdbId}"
                   target="_blank" rel="noopener noreferrer">TMDB</a>`
              : ""}
          </div>
          <button class="primary" id="details-save">
            ${savedMovies.has(id) ? "Remove from watchlist" : "Add to watchlist"}
          </button>
        </div>
      `;

      $("#details-save").onclick = () => {
        saveMovie(id);
        $("#details-save").textContent = savedMovies.has(id)
          ? "Remove from watchlist"
          : "Add to watchlist";
      };
    } catch (error) {
      if (version !== detailsVersion) return;

      $("#details-content").innerHTML = `
        <div class="details-body">
          <p>${escapeHTML(error.message)}</p>
          <button class="primary" data-details="${id}">Retry</button>
        </div>
      `;
    }
  };

  $("#about-button").onclick = () => {
    ++detailsVersion;

    $("#details-content").innerHTML = `
      <h2>Frame</h2>
      <div class="details-body">
        <p>Discover movies from TMDB with a feed influenced by your watchlist.</p>
        <p>Fresh feeds exclude saved movies and films already viewed
          on this browser. Returning to a feed keeps your place.</p>
        <p>New movie ratings come from TMDB, not IMDb.
          Historical watchlist entries keep their original IMDb ratings.</p>
        <p>Your watchlist and viewing history stay on this device.
          Clearing browser data removes that history.</p>
        <p><a href="https://www.themoviedb.org" target="_blank"
          rel="noopener noreferrer">Movie data and images: TMDB</a></p>
        <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </div>
    `;

    if (!$("#details-dialog").open) $("#details-dialog").showModal();
  };

  // Make credits reachable on mobile, where the desktop About button is hidden.
  const creditsButton = document.createElement("button");
  creditsButton.type = "button";
  creditsButton.textContent = "About Frame · Movie data by TMDB";
  creditsButton.className = "live-credit";
  creditsButton.onclick = () => $("#about-button").click();
  $("#filters").appendChild(creditsButton);

  document.addEventListener("click", event => {
    if (event.target.closest("[data-live-retry]")) start();
    if (event.target.closest("[data-live-more]") && activeState) {
      loadMore(activeState);
    }
  });

  function onScroll() {
    if (!activeState) return;
    rememberPosition();

    const target = view === "feed" ? feed : grid;

    if (
      !activeState.error &&
      activeState.items.length &&
      target.scrollHeight - target.scrollTop - target.clientHeight <
        target.clientHeight * 2
    ) {
      loadMore(activeState);
    }

    scheduleSeen();
  }

  feed.addEventListener("scroll", onScroll, { passive: true });
  grid.addEventListener("scroll", onScroll, { passive: true });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(seenTimer);
    else scheduleSeen();
  });

  // The original input listener calls render. Debounce that call here.
  const immediateRender = render;

  render = function () {
    if (view === "explore" && document.activeElement === search) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(immediateRender, 350);
    } else {
      clearTimeout(searchTimer);
      immediateRender();
    }
  };

  // If the original catalog is still loading, its initialization will
  // call this renderer when ready. Otherwise start immediately.
    /*
   * Keep the feed position during phone rotation.
   * Layout changes must not be treated as movie scrolling.
   */
  let phoneTurning = false;
  let portraitPosition = null;
  let rotationTimer = null;
  let rotationVersion = 0;

  function isPhoneDevice() {
    return (
      matchMedia("(pointer:coarse)").matches &&
      Math.min(screen.width, screen.height) < 600
    );
  }

  function phoneIsLandscape() {
    if (screen.orientation?.type) {
      return screen.orientation.type.startsWith("landscape");
    }

    if (typeof window.orientation === "number") {
      return Math.abs(window.orientation) === 90;
    }

    return matchMedia("(orientation: landscape)").matches;
  }

  const rememberBeforeRotationFix = rememberPosition;

  rememberPosition = function () {
    if (phoneTurning) return;
    if (isPhoneDevice() && phoneIsLandscape()) return;

    rememberBeforeRotationFix();

    if (
      displayedView === "feed" &&
      displayedState &&
      displayedState.anchor != null
    ) {
      portraitPosition = {
        state: displayedState,
        id: displayedState.anchor
      };
    }
  };

  const seenBeforeRotationFix = scheduleSeen;

  scheduleSeen = function () {
    if (
      phoneTurning ||
      (isPhoneDevice() && phoneIsLandscape())
    ) {
      clearTimeout(seenTimer);
      return;
    }

    seenBeforeRotationFix();
  };

  // Replace the existing scroll listeners with guarded listeners.
  const scrollBeforeRotationFix = onScroll;

  feed.removeEventListener("scroll", onScroll);
  grid.removeEventListener("scroll", onScroll);

  onScroll = function () {
    if (
      phoneTurning ||
      (isPhoneDevice() && phoneIsLandscape())
    ) {
      return;
    }

    scrollBeforeRotationFix();
  };

  feed.addEventListener("scroll", onScroll, { passive: true });
  grid.addEventListener("scroll", onScroll, { passive: true });

  function handlePhoneRotation() {
    if (!isPhoneDevice()) return;

    const landscape = phoneIsLandscape();

    // Normal portrait resizing, such as Safari's toolbar, is ignored.
    if (!landscape && !phoneTurning) return;

    clearTimeout(rotationTimer);
    clearTimeout(seenTimer);
    const version = ++rotationVersion;

    if (!phoneTurning) {
      phoneTurning = true;

      if (
        activeState &&
        view === "feed" &&
        portraitPosition?.state !== activeState
      ) {
        portraitPosition = {
          state: activeState,
          id: activeState.anchor ?? activeState.items[0]?.id
        };
      }

      if (
        portraitPosition &&
        portraitPosition.state === activeState
      ) {
        activeState.anchor = portraitPosition.id;
      }
    }

    // Stay paused while the existing portrait warning is visible.
    if (landscape) return;

    rotationTimer = setTimeout(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (version !== rotationVersion) return;
          if (phoneIsLandscape()) return;

          const saved = portraitPosition;

          if (
            view === "feed" &&
            saved &&
            saved.state === activeState &&
            saved.id != null
          ) {
            activeState.anchor = saved.id;

            const card = feed.querySelector(
              `.movie[data-id="${saved.id}"]`
            );

            if (card) {
              const previousBehavior = feed.style.scrollBehavior;
              const previousSnap = feed.style.scrollSnapType;

              feed.style.scrollBehavior = "auto";
              feed.style.scrollSnapType = "none";
              feed.scrollTop = card.offsetTop;

              requestAnimationFrame(() => {
                feed.style.scrollSnapType = previousSnap;
                feed.style.scrollBehavior = previousBehavior;
              });
            }
          }

          // Allow rotation-related scroll events to finish first.
          rotationTimer = setTimeout(() => {
            if (version !== rotationVersion) return;
            if (phoneIsLandscape()) return;

            phoneTurning = false;
            rememberPosition();
            scheduleSeen();
          }, 200);
        });
      });
    }, 300);
  }

  window.addEventListener(
    "orientationchange",
    handlePhoneRotation
  );

  window.addEventListener("resize", handlePhoneRotation);

  screen.orientation?.addEventListener(
    "change",
    handlePhoneRotation
  );

  /*
   * House navigation icon.
   */
  const homeButton = document.querySelector(
    '.nav-button[data-view="feed"]'
  );

  if (homeButton) {
    const iconContainer = homeButton.querySelector("[data-icon]");

    if (iconContainer) {
      iconContainer.innerHTML = `
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="m3 10 9-7 9 7"/>
          <path d="M5 9v11h5v-6h4v6h5V9"/>
        </svg>
      `;
    }

    const label = homeButton.querySelector(".nav-text");
    if (label) label.textContent = "Home";

    homeButton.setAttribute("aria-label", "Home");
    homeButton.title = "Home — tap again for a fresh mix";
  }

  /*
   * From another screen: Home returns to the existing feed.
   * Already on Home: Home starts a fresh mix.
   * Watchlist and viewing history are preserved.
   */
  document.addEventListener("click", event => {
    const button = event.target.closest(
      '.nav-button[data-view="feed"]'
    );

    if (!button || view !== "feed" || !ready) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    clearTimeout(seenTimer);
    portraitPosition = null;

    document.getElementById("restart-button").click();
  }, true);

  if (movies.length) render();
})();
