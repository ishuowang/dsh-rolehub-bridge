window.__ModuleLoader__.load({ id: 'dsh-rolehub-bridge', factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  ROLEHUB_FOOTER_ENTRY_ID: () => ROLEHUB_FOOTER_ENTRY_ID,
  ROLEHUB_HEADER_ENTRY_ID: () => ROLEHUB_HEADER_ENTRY_ID,
  ROLEHUB_NATIVE_API_PREFIX: () => ROLEHUB_NATIVE_API_PREFIX,
  ROLEHUB_ROOM_FOOTER_INVITE_ENTRY_ID: () => ROLEHUB_ROOM_FOOTER_INVITE_ENTRY_ID,
  ROLEHUB_ROOM_INVITE_ENTRY_ID: () => ROLEHUB_ROOM_INVITE_ENTRY_ID,
  apply: () => apply,
  availableTags: () => availableTags,
  buildStartRoleCommand: () => buildStartRoleCommand,
  filterRoles: () => filterRoles,
  inject: () => inject,
  loadRoleHubSnapshot: () => loadRoleHubSnapshot,
  roleHubSnapshotUrl: () => roleHubSnapshotUrl,
  roleKey: () => roleKey,
  roleSelector: () => roleSelector
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var ROLEHUB_HEADER_ENTRY_ID = "dsh-rolehub-bridge-header";
var ROLEHUB_FOOTER_ENTRY_ID = "dsh-rolehub-bridge-footer";
var ROLEHUB_ROOM_INVITE_ENTRY_ID = "dsh-rolehub-bridge-room-invite";
var ROLEHUB_ROOM_FOOTER_INVITE_ENTRY_ID = "dsh-rolehub-bridge-room-invite-footer";
var ROLEHUB_NATIVE_API_PREFIX = "/rolehub-bridge/api/session/";
var EMPTY_SNAPSHOT = {
  hubs: [],
  roles: [],
  rooms: [],
  roomAvailable: false
};
var color = {
  panel: "var(--dsw-alias-bg-layer-1, #fff)",
  subtle: "var(--dsw-alias-bg-layer-2, #f7f7f8)",
  raised: "var(--dsw-alias-bg-layer-3, #f0f1f4)",
  border: "var(--dsw-alias-border-normal, rgba(0,0,0,.1))",
  text: "var(--dsw-alias-label-primary, #171717)",
  muted: "var(--dsw-alias-label-secondary, #6b6b6b)",
  accent: "var(--dsw-alias-interactive-primary, #4d6bfe)",
  danger: "var(--dsw-alias-label-error, #d84a4a)",
  success: "var(--dsw-alias-label-success, #18834b)",
  warning: "var(--dsw-alias-label-warning, #8a5a00)"
};
var cardStyle = {
  border: `1px solid ${color.border}`,
  borderRadius: 14,
  background: color.panel
};
function commandQuote(value) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
function roleSelector(role) {
  return `${role.hubId}/${role.name}`;
}
function buildStartRoleCommand(role, options = {}) {
  const parts = ["/rolehub start", commandQuote(roleSelector(role))];
  const label = options.label?.trim();
  const roomId = options.roomId?.trim();
  const prompt = options.prompt?.trim();
  if (label) parts.push("--label", commandQuote(label));
  if (roomId) parts.push("--room", commandQuote(roomId));
  if (prompt) parts.push("--prompt", commandQuote(prompt));
  return parts.join(" ");
}
function roleHubSnapshotUrl(sessionId) {
  return `${ROLEHUB_NATIVE_API_PREFIX}${encodeURIComponent(sessionId)}`;
}
function isNativeSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value;
  return Array.isArray(candidate.hubs) && Array.isArray(candidate.roles) && Array.isArray(candidate.rooms) && typeof candidate.roomAvailable === "boolean";
}
async function loadRoleHubSnapshot(sessionId, signal) {
  const response = await fetch(roleHubSnapshotUrl(sessionId), {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    ...signal ? { signal } : {}
  });
  if (!response.ok) throw new Error(`RoleHub snapshot failed (${response.status})`);
  const value = await response.json();
  if (!isNativeSnapshot(value)) throw new Error("RoleHub snapshot has an invalid shape");
  return value;
}
function roleKey(role) {
  return `${role.hubId}/${role.name}@${role.version}`;
}
function availableTags(roles) {
  return [...new Set(roles.flatMap((role) => role.tags))].sort((left, right) => left.localeCompare(right, "en"));
}
function filterRoles(roles, query, hubId = "all", tag = "all") {
  const needle = query.trim().toLocaleLowerCase();
  return roles.filter((role) => {
    if (hubId !== "all" && role.hubId !== hubId) return false;
    if (tag !== "all" && !role.tags.includes(tag)) return false;
    if (!needle) return true;
    return [
      role.displayName,
      role.id,
      role.description,
      role.publisher,
      ...role.tags,
      ...role.capabilities.required,
      ...role.capabilities.optional,
      ...role.capabilities.denied
    ].some((value) => value.toLocaleLowerCase().includes(needle));
  });
}
function shortDigest(value) {
  return value.length > 18 ? `${value.slice(0, 10)}\u2026${value.slice(-8)}` : value;
}
function Empty({ children }) {
  return (0, import_react.createElement)("div", {
    style: {
      display: "grid",
      placeItems: "center",
      minHeight: 150,
      padding: 24,
      color: color.muted,
      fontSize: 13,
      textAlign: "center"
    },
    children
  });
}
function Chip({ active, children, onClick }) {
  return (0, import_react.createElement)("button", {
    type: "button",
    "aria-pressed": active,
    onClick,
    style: {
      border: `1px solid ${active ? color.accent : color.border}`,
      borderRadius: 999,
      padding: "4px 9px",
      background: active ? color.raised : "transparent",
      color: color.text,
      cursor: "pointer",
      font: "inherit",
      fontSize: 11,
      whiteSpace: "nowrap"
    },
    children
  });
}
function CapabilityGroup({ label, values, tone }) {
  const toneColor = tone === "denied" ? color.danger : tone === "required" ? color.accent : color.muted;
  return (0, import_react.createElement)("section", {
    style: { display: "grid", gap: 7 },
    children: [
      (0, import_react.createElement)("div", {
        key: "label",
        style: { color: toneColor, fontSize: 11, fontWeight: 700, textTransform: "uppercase" },
        children: `${label} \xB7 ${values.length}`
      }),
      values.length === 0 ? (0, import_react.createElement)("span", { key: "empty", style: { color: color.muted, fontSize: 12 }, children: "None" }) : (0, import_react.createElement)("div", {
        key: "values",
        style: { display: "flex", flexWrap: "wrap", gap: 5 },
        children: values.map((value) => (0, import_react.createElement)(import_dsh_client_ui_primitives.Pill, { key: value, children: value }))
      })
    ]
  });
}
function RoleHubLauncher({ sessionId, sessions, wide, location, roomContext }) {
  const [open, setOpen] = (0, import_react.useState)(false);
  const [snapshot, setSnapshot] = (0, import_react.useState)(EMPTY_SNAPSHOT);
  const [query, setQuery] = (0, import_react.useState)("");
  const [hubId, setHubId] = (0, import_react.useState)("all");
  const [tag, setTag] = (0, import_react.useState)("all");
  const [selectedKey, setSelectedKey] = (0, import_react.useState)();
  const [roomId, setRoomId] = (0, import_react.useState)(roomContext?.roomId ?? "");
  const [label, setLabel] = (0, import_react.useState)("");
  const [prompt, setPrompt] = (0, import_react.useState)("");
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)();
  const [notice, setNotice] = (0, import_react.useState)();
  const refresh = (0, import_react.useCallback)(async (signal) => {
    if (!sessionId) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    setLoading(true);
    setError(void 0);
    try {
      const next = await loadRoleHubSnapshot(sessionId, signal);
      setSnapshot(next);
      setSelectedKey((current) => current && next.roles.some((role) => roleKey(role) === current) ? current : next.roles[0] ? roleKey(next.roles[0]) : void 0);
      if (!next.roomAvailable && !roomContext) setRoomId("");
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [sessionId]);
  (0, import_react.useEffect)(() => {
    if (!open || !sessionId) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [open, refresh, sessionId]);
  (0, import_react.useEffect)(() => {
    if (roomContext) setRoomId(roomContext.roomId);
  }, [roomContext?.roomId]);
  const tags = (0, import_react.useMemo)(() => availableTags(snapshot.roles), [snapshot.roles]);
  const filtered = (0, import_react.useMemo)(
    () => filterRoles(snapshot.roles, query, hubId, tag),
    [hubId, query, snapshot.roles, tag]
  );
  const selected = filtered.find((role) => roleKey(role) === selectedKey) ?? filtered[0];
  const start = async () => {
    if (!sessionId || !selected) return;
    const live = sessions.binding(sessionId)?.session;
    if (!live) throw new Error("The current Session is not materialized yet");
    setBusy(true);
    setError(void 0);
    setNotice(void 0);
    try {
      const result = await live.command(buildStartRoleCommand(selected, {
        ...label.trim() ? { label } : {},
        ...roomId ? { roomId } : {},
        ...prompt.trim() ? { prompt } : {}
      }));
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      if (!result.value.matched) throw new Error("The Host does not offer the /rolehub command");
      setNotice(roomId ? "Role Session created and attached to the selected Room." : "Role Session created. It remains independent until you attach it to a Room.");
      setPrompt("");
      if (roomId && roomContext) roomContext.onAttached();
      await sessions.refreshSubagents(sessionId).catch(() => void 0);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  };
  const refreshHubs = async () => {
    if (!sessionId) return;
    const live = sessions.binding(sessionId)?.session;
    if (!live) throw new Error("The current Session is not materialized yet");
    setLoading(true);
    setError(void 0);
    try {
      const result = await live.command("/rolehub refresh");
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      if (!result.value.matched) throw new Error("The Host does not offer the /rolehub command");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setLoading(false);
    }
  };
  const trigger = location === "header" ? (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, {
    variant: "toolbar",
    size: "sm",
    icon: (0, import_react.createElement)(import_dsh_client_ui_primitives.IconAgentPresetOutline16, { size: 16 }),
    "aria-label": "Open RoleHub",
    id: "rolehub-header-trigger",
    disabled: !sessionId,
    onClick: () => setOpen(true),
    children: "RoleHub"
  }) : location === "footer" ? (0, import_react.createElement)(import_dsh_client_ui_primitives.Tooltip, {
    label: "Open RoleHub",
    side: "right",
    delayMs: 500,
    disabled: wide ?? false,
    children: (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, {
      variant: "toolbar",
      size: "sm",
      icon: (0, import_react.createElement)(import_dsh_client_ui_primitives.IconAgentPresetOutline16, { size: wide ? 16 : 18 }),
      "aria-label": "Open RoleHub",
      id: "rolehub-footer-trigger",
      disabled: !sessionId,
      onClick: () => setOpen(true),
      style: { width: wide ? "100%" : 36, justifyContent: wide ? "flex-start" : "center" },
      children: wide ? "RoleHub" : void 0
    })
  }) : (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, {
    variant: "outline",
    size: "sm",
    icon: (0, import_react.createElement)(import_dsh_client_ui_primitives.IconAgentPresetOutline16, { size: 14 }),
    "aria-label": `Choose a RoleHub role for ${roomContext?.roomName ?? "this Room"}`,
    disabled: !sessionId || roomContext?.disabled,
    onClick: () => setOpen(true),
    children: "Choose RoleHub role"
  });
  const browser = (0, import_react.createElement)("aside", {
    style: { ...cardStyle, flex: "1 1 250px", minWidth: 220, padding: 12, overflow: "auto" },
    children: [
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Input, {
        key: "search",
        value: query,
        icon: (0, import_react.createElement)(import_dsh_client_ui_primitives.IconSearchOutline16, { size: 15 }),
        "aria-label": "Search RoleHub roles",
        placeholder: "Search roles, tags, capabilities\u2026",
        onChange: (event) => setQuery(event.currentTarget.value)
      }),
      (0, import_react.createElement)("div", {
        key: "hubs",
        "aria-label": "Filter by Hub",
        style: { display: "flex", gap: 5, overflowX: "auto", padding: "10px 0 7px" },
        children: [
          (0, import_react.createElement)(Chip, { key: "all", active: hubId === "all", onClick: () => setHubId("all"), children: "All Hubs" }),
          ...snapshot.hubs.map((hub) => (0, import_react.createElement)(Chip, {
            key: hub.id,
            active: hubId === hub.id,
            onClick: () => setHubId(hub.id),
            children: hub.id
          }))
        ]
      }),
      (0, import_react.createElement)("div", {
        key: "tags",
        "aria-label": "Filter by tag",
        style: { display: "flex", gap: 5, overflowX: "auto", paddingBottom: 10 },
        children: [
          (0, import_react.createElement)(Chip, { key: "all", active: tag === "all", onClick: () => setTag("all"), children: "All tags" }),
          ...tags.map((value) => (0, import_react.createElement)(Chip, {
            key: value,
            active: tag === value,
            onClick: () => setTag(value),
            children: `#${value}`
          }))
        ]
      }),
      filtered.length === 0 ? (0, import_react.createElement)(Empty, { key: "empty", children: loading ? "Loading RoleHub\u2026" : "No role matches these filters." }) : (0, import_react.createElement)("div", {
        key: "roles",
        "data-rolehub-role-list": true,
        style: { display: "grid", gap: 6 },
        children: filtered.map((role) => {
          const active = selected ? roleKey(role) === roleKey(selected) : false;
          return (0, import_react.createElement)("button", {
            key: roleKey(role),
            type: "button",
            "aria-pressed": active,
            onClick: () => {
              setSelectedKey(roleKey(role));
              if (!label.trim()) setLabel(role.displayName);
            },
            style: {
              display: "grid",
              gap: 4,
              width: "100%",
              padding: "10px 11px",
              border: `1px solid ${active ? color.accent : "transparent"}`,
              borderRadius: 11,
              background: active ? color.subtle : "transparent",
              color: color.text,
              textAlign: "left",
              cursor: "pointer",
              font: "inherit"
            },
            children: [
              (0, import_react.createElement)("span", {
                key: "head",
                style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
                children: [
                  (0, import_react.createElement)("strong", { key: "name", style: { fontSize: 13 }, children: role.displayName }),
                  role.installed ? (0, import_react.createElement)("span", {
                    key: "installed",
                    title: "Verified locally",
                    "aria-label": "Verified locally",
                    children: (0, import_react.createElement)(import_dsh_client_ui_primitives.IconCheckOutline16, { size: 14 })
                  }) : null
                ]
              }),
              (0, import_react.createElement)("span", {
                key: "meta",
                style: { color: color.muted, fontSize: 11 },
                children: `${role.hubId} \xB7 v${role.version} \xB7 ${role.trust}`
              })
            ]
          });
        })
      })
    ]
  });
  const detail = selected ? (0, import_react.createElement)("section", {
    style: { ...cardStyle, flex: "2 1 390px", minWidth: 0, padding: 16, overflow: "auto" },
    children: [
      (0, import_react.createElement)("header", {
        key: "header",
        style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
        children: [
          (0, import_react.createElement)("div", {
            key: "identity",
            style: { minWidth: 0 },
            children: [
              (0, import_react.createElement)("div", {
                key: "eyebrow",
                style: { color: color.accent, fontSize: 11, fontWeight: 700, textTransform: "uppercase" },
                children: `${selected.hubId} / ${selected.publisher}`
              }),
              (0, import_react.createElement)("h3", {
                key: "name",
                style: { margin: "4px 0 0", fontSize: 20, lineHeight: 1.2 },
                children: selected.displayName
              }),
              (0, import_react.createElement)("p", {
                key: "description",
                style: { margin: "7px 0 0", color: color.muted, fontSize: 13, lineHeight: 1.5 },
                children: selected.description
              })
            ]
          }),
          (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, {
            key: "refresh",
            variant: "toolbar",
            size: "sm",
            icon: (0, import_react.createElement)(import_dsh_client_ui_primitives.IconRefreshOutline16, { size: 14 }),
            "aria-label": "Refresh RoleHub",
            title: "Refresh RoleHub",
            disabled: loading,
            onClick: () => void refreshHubs().catch(() => void 0)
          })
        ]
      }),
      (0, import_react.createElement)("div", {
        key: "tags",
        style: { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 12 },
        children: selected.tags.map((value) => (0, import_react.createElement)(import_dsh_client_ui_primitives.Pill, { key: value, children: `#${value}` }))
      }),
      (0, import_react.createElement)("div", {
        key: "digest",
        "data-rolehub-digest-lock": true,
        title: selected.bundleDigest,
        style: {
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginTop: 14,
          padding: "9px 10px",
          borderRadius: 10,
          background: color.subtle,
          color: color.muted,
          fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
          fontSize: 11
        },
        children: [
          (0, import_react.createElement)(import_dsh_client_ui_primitives.IconCheckOutline16, { key: "icon", size: 14 }),
          (0, import_react.createElement)("span", {
            key: "copy",
            children: `Bundle locked \xB7 sha256:${shortDigest(selected.bundleDigest)}`
          })
        ]
      }),
      (0, import_react.createElement)("div", {
        key: "capabilities",
        style: { display: "grid", gap: 13, marginTop: 17 },
        children: [
          (0, import_react.createElement)(CapabilityGroup, { key: "required", label: "Required", values: selected.capabilities.required, tone: "required" }),
          (0, import_react.createElement)(CapabilityGroup, { key: "optional", label: "Optional", values: selected.capabilities.optional, tone: "optional" }),
          (0, import_react.createElement)(CapabilityGroup, { key: "denied", label: "Denied", values: selected.capabilities.denied, tone: "denied" })
        ]
      }),
      (0, import_react.createElement)("div", {
        key: "start",
        style: { display: "grid", gap: 9, marginTop: 18, paddingTop: 16, borderTop: `1px solid ${color.border}` },
        children: [
          (0, import_react.createElement)("strong", {
            key: "title",
            style: { display: "flex", alignItems: "center", gap: 7, fontSize: 13 },
            children: [(0, import_react.createElement)(import_dsh_client_ui_primitives.IconSkillOutline16, { key: "icon", size: 15 }), "Create a role-scoped Session"]
          }),
          (0, import_react.createElement)(import_dsh_client_ui_primitives.Input, {
            key: "label",
            value: label,
            "aria-label": "Role Session label",
            placeholder: selected.displayName,
            onChange: (event) => setLabel(event.currentTarget.value)
          }),
          (0, import_react.createElement)("textarea", {
            key: "prompt",
            value: prompt,
            "aria-label": "Initial role prompt",
            placeholder: "Initial task (optional)",
            rows: 3,
            onChange: (event) => setPrompt(event.currentTarget.value),
            style: {
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
              border: `1px solid ${color.border}`,
              borderRadius: 10,
              padding: "9px 11px",
              background: color.panel,
              color: color.text,
              font: "inherit",
              fontSize: 13
            }
          }),
          roomContext ? (0, import_react.createElement)("div", {
            key: "room-context",
            style: { padding: "9px 10px", borderRadius: 9, background: color.subtle, color: color.muted, fontSize: 12 },
            children: `Attach to Room \xB7 ${roomContext.roomName}`
          }) : snapshot.roomAvailable ? (0, import_react.createElement)("label", {
            key: "room",
            style: { display: "grid", gap: 5, color: color.muted, fontSize: 11 },
            children: [
              "Room (optional)",
              (0, import_react.createElement)("select", {
                value: roomId,
                "aria-label": "Attach role Session to Room",
                onChange: (event) => setRoomId(event.currentTarget.value),
                style: {
                  minHeight: 36,
                  border: `1px solid ${color.border}`,
                  borderRadius: 10,
                  padding: "0 10px",
                  background: color.panel,
                  color: color.text,
                  font: "inherit"
                },
                children: [
                  (0, import_react.createElement)("option", { key: "none", value: "", children: "No Room \u2014 independent Session" }),
                  ...snapshot.rooms.filter((room) => room.status !== "closed").map((room) => (0, import_react.createElement)("option", {
                    key: room.id,
                    value: room.id,
                    children: room.name
                  }))
                ]
              })
            ]
          }) : (0, import_react.createElement)("div", {
            key: "room-unavailable",
            style: { padding: "8px 10px", borderRadius: 9, background: color.subtle, color: color.muted, fontSize: 11 },
            children: "Agent Team Room is optional and is not loaded. This role will start as an independent child Session."
          }),
          (0, import_react.createElement)(import_dsh_client_ui_primitives.Button, {
            key: "submit",
            variant: "primary",
            disabled: busy || !sessionId,
            onClick: () => void start().catch(() => void 0),
            children: busy ? "Starting\u2026" : roomId ? "Start and attach to Room" : "Start role Session"
          })
        ]
      })
    ]
  }) : (0, import_react.createElement)(Empty, { children: loading ? "Loading RoleHub\u2026" : "Select a role to inspect its locked bundle and capabilities." });
  return (0, import_react.createElement)("span", {
    children: [
      trigger,
      (0, import_react.createElement)(import_dsh_client_ui_primitives.Modal, {
        key: "modal",
        open,
        onClose: () => setOpen(false),
        title: "RoleHub",
        description: "Discover a role, inspect its requested capabilities, then create a separate verified Session.",
        children: (0, import_react.createElement)("div", {
          style: { width: "100%", color: color.text },
          children: [
            error ? (0, import_react.createElement)("div", {
              key: "error",
              role: "alert",
              style: { marginBottom: 10, padding: "9px 11px", borderRadius: 10, background: "#fff0f0", color: color.danger, fontSize: 12 },
              children: error
            }) : null,
            notice ? (0, import_react.createElement)("div", {
              key: "notice",
              role: "status",
              style: { marginBottom: 10, padding: "9px 11px", borderRadius: 10, background: color.subtle, color: color.success, fontSize: 12 },
              children: notice
            }) : null,
            (0, import_react.createElement)("div", {
              key: "layout",
              style: { display: "flex", flexWrap: "wrap", gap: 12, minHeight: 470, maxHeight: "min(74vh, 760px)" },
              children: [browser, detail]
            })
          ]
        })
      })
    ]
  });
}
var inject = ["slots", "sessions"];
function renderRoomInvite(props, sessions) {
  return (0, import_react.createElement)(RoleHubLauncher, {
    sessionId: props.sessionId,
    sessions,
    location: "room",
    roomContext: {
      roomId: props.roomId,
      roomName: props.roomName,
      disabled: props.disabled,
      onAttached: props.onAttached
    }
  });
}
function apply(ctx) {
  const sessions = ctx.get("sessions");
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions",
    id: ROLEHUB_HEADER_ENTRY_ID,
    order: 30
  }, (props) => (0, import_react.createElement)(RoleHubLauncher, {
    sessionId: props.sessionId,
    sessions,
    location: "header"
  })));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: ROLEHUB_FOOTER_ENTRY_ID,
    order: 30
  }, (props) => {
    const state = props.useSessions((value) => value);
    return (0, import_react.createElement)(RoleHubLauncher, {
      sessionId: state.current,
      sessions,
      wide: props.wide,
      location: "footer"
    });
  }));
  ctx.slots.inject("agent-team-room.invite.provider", () => ctx.slots.register({
    name: "agent-team-room.invite.provider",
    id: ROLEHUB_ROOM_INVITE_ENTRY_ID,
    order: 10
  }, (props) => renderRoomInvite(props, sessions)));
  ctx.slots.inject("agent-team-room.invite.provider.footer", () => ctx.slots.register({
    name: "agent-team-room.invite.provider.footer",
    id: ROLEHUB_ROOM_FOOTER_INVITE_ENTRY_ID,
    order: 10
  }, (props) => renderRoomInvite(props, sessions)));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
