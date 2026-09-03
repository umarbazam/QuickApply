/**
 * QuickApply — Storage Utility Module
 * Wraps chrome.storage.local for client profile CRUD operations.
 * Reference: DATA_SCHEMA.md § 1
 */

(function () {
  'use strict';

  const STORAGE_KEYS = {
    CLIENTS: 'quickapply_clients',
    SETTINGS: 'quickapply_settings',
    VERSION: 'quickapply_version',
    DAILY_COUNTS: 'quickapply_daily_counts'
  };

  const SCHEMA_VERSION = '1.0';

  const DEFAULT_SETTINGS = {
    highlightDuration: 10,
    highlightEnabled: true,
    fillDelay: 50,
    autoExpandSections: true,
    confirmFuzzyMatches: true,
    geminiApiKey: '',
    // When true, ai-resolver.js skips Tier 1 (profile-direct) and Tier 2 (cache)
    // and sends every field straight to Gemini. Costs more API tokens and adds
    // latency, but bypasses any wrong T1 mappings or stale cache entries.
    forceAI: false,
    // Job Analyzer (Fit Card)
    showFitVerdict: true,
    showFitBreakdown: true,
    fitWeights: { yoe: 40, title: 25, skills: 25, salary: 10 },
    // 'detailed' = full 8-row breakdown; 'compact' = verdict + worst param only.
    // Compact has an inline "Show details" affordance so users can expand
    // without changing the saved setting.
    fitCardMode: 'detailed',
    // Floating mini-card overlay on JD pages (Feature 3.2).
    showMiniCard: true,
    // Daily submission counters (see spec 2026-06-01).
    dailyDefaultTarget: 5,
    shiftCutoffHour: 4
  };

  const AVATAR_COLORS = [
    '#F87171', '#34D399', '#7C6AFF', '#FBBF24', '#60A5FA',
    '#F472B6', '#2DD4BF', '#C084FC', '#FB923C', '#A3E635'
  ];

  // ─── UUID v4 Generator ──────────────────────────────────────────

  function generateId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32)
    ].join('-');
  }

  // ─── Storage Helpers ────────────────────────────────────────────

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  }

  function storageSet(data) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  function storageRemove(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  // ─── Client CRUD ────────────────────────────────────────────────

  /**
   * Backfill missing array fields so old profiles don't crash.
   * @param {Object} p - ClientProfile object
   * @returns {Object} Migrated profile
   */
  function _migrateProfile(p) {
    if (!Array.isArray(p.preferredLocations)) p.preferredLocations = [];
    if (!Array.isArray(p.targetRoles)) p.targetRoles = [];
    if (p.dailyTarget === undefined) p.dailyTarget = null;
    return p;
  }

  /**
   * Get all client profiles.
   * @returns {Promise<Array>} Array of ClientProfile objects
   */
  async function getClients() {
    try {
      const result = await storageGet([STORAGE_KEYS.CLIENTS]);
      return (result[STORAGE_KEYS.CLIENTS] || []).map(_migrateProfile);
    } catch (err) {
      console.error('[QuickApply] getClients error:', err);
      return [];
    }
  }

  /**
   * Get a single client by ID.
   * @param {string} id - Client UUID
   * @returns {Promise<Object|null>}
   */
  async function getClientById(id) {
    try {
      const clients = await getClients();
      const found = clients.find(c => c.id === id) || null;
      return found; // getClients() already runs _migrateProfile on each item
    } catch (err) {
      console.error('[QuickApply] getClientById error:', err);
      return null;
    }
  }

  /**
   * Save (create or update) a client profile.
   * @param {Object} profile - ClientProfile data
   * @returns {Promise<Object>} Saved profile with computed fields
   */
  async function saveClient(profile) {
    try {
      const clients = await getClients();
      const now = new Date().toISOString();

      // Auto-compute fields
      profile.fullName = ((profile.firstName || '') + ' ' + (profile.lastName || '')).trim();
      profile.updatedAt = now;

      const existingIndex = clients.findIndex(c => c.id === profile.id);

      if (existingIndex >= 0) {
        // Update existing
        clients[existingIndex] = { ...clients[existingIndex], ...profile };
      } else {
        // Create new
        profile.id = profile.id || generateId();
        profile.createdAt = now;
        profile.avatarColor = AVATAR_COLORS[clients.length % AVATAR_COLORS.length];
        clients.push(profile);
      }

      await storageSet({ [STORAGE_KEYS.CLIENTS]: clients });
      return profile;
    } catch (err) {
      console.error('[QuickApply] saveClient error:', err);
      throw err;
    }
  }

  /**
   * Delete a client by ID.
   * @param {string} id - Client UUID
   * @returns {Promise<boolean>} true if deleted
   */
  async function deleteClient(id) {
    try {
      const clients = await getClients();
      const filtered = clients.filter(c => c.id !== id);

      if (filtered.length === clients.length) {
        return false; // not found
      }

      await storageSet({ [STORAGE_KEYS.CLIENTS]: filtered });
      return true;
    } catch (err) {
      console.error('[QuickApply] deleteClient error:', err);
      throw err;
    }
  }

  // ─── Import / Export ────────────────────────────────────────────

  /**
   * Export all data as a JSON string.
   * @returns {Promise<string>}
   */
  async function exportAll() {
    try {
      const result = await storageGet([
        STORAGE_KEYS.CLIENTS,
        STORAGE_KEYS.SETTINGS,
        STORAGE_KEYS.VERSION
      ]);

      const exportData = {
        [STORAGE_KEYS.CLIENTS]: result[STORAGE_KEYS.CLIENTS] || [],
        [STORAGE_KEYS.SETTINGS]: result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS,
        [STORAGE_KEYS.VERSION]: SCHEMA_VERSION,
        exportedAt: new Date().toISOString()
      };

      return JSON.stringify(exportData, null, 2);
    } catch (err) {
      console.error('[QuickApply] exportAll error:', err);
      throw err;
    }
  }

  /**
   * Import profiles from a JSON string.
   * @param {string} jsonString
   * @returns {Promise<Object>} { added, updated, skipped, errors }
   */
  async function importAll(jsonString) {
    const result = { added: 0, updated: 0, skipped: 0, errors: [] };

    try {
      const data = JSON.parse(jsonString);
      const importedClients = data[STORAGE_KEYS.CLIENTS];

      if (!Array.isArray(importedClients)) {
        throw new Error('Invalid import file: missing client profiles array');
      }

      const existingClients = await getClients();
      const emailMap = new Map(existingClients.map(c => [c.email, c]));

      for (const imported of importedClients) {
        // Validate required fields
        if (!imported.firstName || !imported.lastName || !imported.email) {
          result.errors.push(`Skipped profile: missing required fields (name/email)`);
          result.skipped++;
          continue;
        }

        const existing = emailMap.get(imported.email);

        if (existing) {
          // Update existing by email match
          const merged = { ...existing, ...imported, id: existing.id };
          merged.updatedAt = new Date().toISOString();
          merged.fullName = ((merged.firstName || '') + ' ' + (merged.lastName || '')).trim();

          const idx = existingClients.findIndex(c => c.id === existing.id);
          existingClients[idx] = merged;
          result.updated++;
        } else {
          // Add new
          imported.id = imported.id || generateId();
          imported.createdAt = imported.createdAt || new Date().toISOString();
          imported.updatedAt = new Date().toISOString();
          imported.fullName = ((imported.firstName || '') + ' ' + (imported.lastName || '')).trim();
          imported.avatarColor = imported.avatarColor || AVATAR_COLORS[existingClients.length % AVATAR_COLORS.length];
          existingClients.push(imported);
          emailMap.set(imported.email, imported);
          result.added++;
        }
      }

      await storageSet({ [STORAGE_KEYS.CLIENTS]: existingClients });

      // Import settings if present
      if (data[STORAGE_KEYS.SETTINGS]) {
        await saveSettings(data[STORAGE_KEYS.SETTINGS]);
      }

      return result;
    } catch (err) {
      if (err instanceof SyntaxError) {
        result.errors.push('Invalid JSON file');
      } else {
        result.errors.push(err.message);
      }
      return result;
    }
  }

  // ─── Settings ───────────────────────────────────────────────────

  /**
   * Get application settings.
   * @returns {Promise<Object>}
   */
  async function getSettings() {
    try {
      const result = await storageGet([STORAGE_KEYS.SETTINGS]);
      const stored = result[STORAGE_KEYS.SETTINGS];
      const safe = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
      return { ...DEFAULT_SETTINGS, ...safe };
    } catch (err) {
      console.error('[QuickApply] getSettings error:', err);
      return { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * Save application settings.
   * @param {Object} settings
   * @returns {Promise<void>}
   */
  async function saveSettings(settings) {
    try {
      const current = await getSettings();
      await storageSet({
        [STORAGE_KEYS.SETTINGS]: { ...current, ...settings }
      });
    } catch (err) {
      console.error('[QuickApply] saveSettings error:', err);
      throw err;
    }
  }

  // ─── Storage Usage ──────────────────────────────────────────────

  /**
   * Get storage usage info.
   * @returns {Promise<Object>} { used: bytes, clientCount: number }
   */
  async function getStorageUsage() {
    try {
      const clients = await getClients();
      const dataString = JSON.stringify(clients);
      const usedBytes = new Blob([dataString]).size;
      return {
        used: usedBytes,
        clientCount: clients.length,
        formatted: formatBytes(usedBytes)
      };
    } catch (err) {
      console.error('[QuickApply] getStorageUsage error:', err);
      return { used: 0, clientCount: 0, formatted: '0 B' };
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  // ─── Initialize ─────────────────────────────────────────────────

  async function initialize() {
    try {
      const result = await storageGet([STORAGE_KEYS.VERSION]);
      if (!result[STORAGE_KEYS.VERSION]) {
        await storageSet({ [STORAGE_KEYS.VERSION]: SCHEMA_VERSION });
      }
    } catch (err) {
      console.error('[QuickApply] initialize error:', err);
    }
  }

  // Note: Initialization is now deferred so the importer can control execution
  // initialize();

  // ─── Daily Submission Counters (spec 2026-06-01) ─────────────────

  function shiftDateOf(t, cutoffHour) {
    const h = Number.isInteger(cutoffHour) ? cutoffHour : 4;
    const d = new Date(t);
    d.setHours(d.getHours() - h);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  async function getDailyCounts() {
    try {
      const result = await storageGet([STORAGE_KEYS.DAILY_COUNTS]);
      const val = result[STORAGE_KEYS.DAILY_COUNTS];
      return (val && typeof val === 'object' && !Array.isArray(val)) ? val : {};
    } catch (err) {
      console.error('[QuickApply] getDailyCounts error:', err);
      return {};
    }
  }

  async function setDailyCounts(counts) {
    try {
      await storageSet({ [STORAGE_KEYS.DAILY_COUNTS]: counts });
    } catch (err) {
      console.error('[QuickApply] setDailyCounts error:', err);
      throw err;
    }
  }

  function pruneOldShifts(counts, keepDays) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cutoff = today.getTime() - keepDays * 24 * 60 * 60 * 1000;
    for (const dateKey of Object.keys(counts)) {
      const [y, m, d] = dateKey.split('-').map(Number);
      if (!y || !m || !d) continue;
      const ts = new Date(y, m - 1, d).getTime();
      if (ts < cutoff) delete counts[dateKey];
    }
  }

  async function recordDailyFill({ clientId, jobKey, settings }) {
    if (!clientId || !jobKey) return 0;
    try {
      const cutoff = (settings && Number.isInteger(settings.shiftCutoffHour))
        ? settings.shiftCutoffHour : 4;
      const date = shiftDateOf(Date.now(), cutoff);
      const counts = await getDailyCounts();
      const day = counts[date] || (counts[date] = {});
      const entry = day[clientId] || (day[clientId] = { jobKeys: [], cappedTarget: null });
      if (!entry.jobKeys.includes(jobKey)) entry.jobKeys.push(jobKey);
      pruneOldShifts(counts, 90);
      await setDailyCounts(counts);
      return entry.jobKeys.length;
    } catch (err) {
      console.error('[QuickApply] recordDailyFill error:', err);
      throw err;
    }
  }

  async function setCappedTarget({ clientId, value, settings }) {
    if (!clientId) return;
    try {
      const cutoff = (settings && Number.isInteger(settings.shiftCutoffHour))
        ? settings.shiftCutoffHour : 4;
      const date = shiftDateOf(Date.now(), cutoff);
      const counts = await getDailyCounts();
      const day = counts[date] || (counts[date] = {});
      const entry = day[clientId] || (day[clientId] = { jobKeys: [], cappedTarget: null });
      entry.cappedTarget = value;  // null = uncap
      await setDailyCounts(counts);
    } catch (err) {
      console.error('[QuickApply] setCappedTarget error:', err);
      throw err;
    }
  }

  function getEffectiveTarget(client, dayEntry, settings) {
    if (dayEntry && dayEntry.cappedTarget != null) return dayEntry.cappedTarget;
    if (client && client.dailyTarget != null) return client.dailyTarget;
    return (settings && Number.isInteger(settings.dailyDefaultTarget))
      ? settings.dailyDefaultTarget : 5;
  }

  // ─── Expose API ─────────────────────────────────────────────────

  const QuickApplyStorage = {
    initialize,
    getClients,
    getClientById,
    saveClient,
    deleteClient,
    exportAll,
    importAll,
    getSettings,
    saveSettings,
    getStorageUsage,
    generateId,
    formatBytes,
    AVATAR_COLORS,
    DEFAULT_SETTINGS,
    getDailyCounts,
    setDailyCounts,
    recordDailyFill,
    setCappedTarget,
    getEffectiveTarget,
    shiftDateOf
  };

  // Make available globally (for content scripts, popup, dashboard)
  if (typeof window !== 'undefined') {
    window.QuickApplyStorage = QuickApplyStorage;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.QuickApplyStorage = QuickApplyStorage;
  }

})();
