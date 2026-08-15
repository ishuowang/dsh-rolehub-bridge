export const DEPLOYMENT_SCHEMA_VERSION = 1;
export const SESSION_BINDING_SCHEMA_VERSION = 1;
export const ROLEHUB_PROVIDER_PREFIX = 'rolehub-bridge-';
export const HOST_TOOL_BINDINGS = {
    'filesystem.read': ['glob', 'grep', 'read', 'read_image'],
    'filesystem.write': ['edit', 'write'],
    'network.fetch': ['web_fetch'],
    'web.search': ['web_search'],
    'source-control.read': ['rolehub_git_read'],
    'room.message': [],
};
//# sourceMappingURL=types.js.map