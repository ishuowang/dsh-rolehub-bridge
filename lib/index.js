import { Context, Service } from '@deepseek-ai/cordis';
import { Config, assertConfig, } from './config.js';
import { assertDeploymentMatchesProvider, createRoleHubContinuableSetup, providerNameForBundleDigest, RoleHubProvider, } from './provider.js';
import { RoleHubResolver } from './resolver.js';
import { SESSION_BINDING_SCHEMA_VERSION, } from './types.js';
export * from './types.js';
export { Config, RoleHubResolver };
export { createEffectivePolicy, assertEffectivePolicy, bindingsForGrants, } from './policy.js';
export { createGitReadTool, buildGitReadArgs, ROLEHUB_GIT_READ_TOOL, } from './git-tool.js';
export { RoleHubProvider, createRoleHubContinuableSetup, providerNameForBundleDigest, } from './provider.js';
export const name = 'rolehub-bridge';
export const inject = ['subagents'];
/** Verified RoleHub deployments and continuable role Session orchestration. */
export class RoleHubBridgeRuntime extends Service {
    config;
    static inject = inject;
    static Config = Config;
    resolver;
    registeredProviders = new Map();
    registryDisposers = new RuntimeDisposerBag();
    constructor(ctx, config, resolver) {
        super(ctx, 'roleHubBridge');
        this.config = config;
        assertConfig(config);
        this.resolver = resolver ?? new RoleHubResolver(config);
    }
    async *[Service.init]() {
        try {
            await this.resolver.init();
            const deployments = await this.resolver.loadDeployments();
            this.registryDisposers.add(this.ctx.subagents.registerContinuableSetup(createRoleHubContinuableSetup(this.resolver)));
            for (const deployment of deployments)
                this.ensureProvider(deployment);
        }
        catch (error) {
            this.registryDisposers.rollback(error);
        }
        yield this.registryDisposers.unifiedDisposer();
    }
    listHubs() {
        return this.config.hubs.map(hub => ({ id: hub.id, catalogUrl: hub.catalogUrl }));
    }
    listRoles() {
        return this.resolver.listRoles().map(copyRoleView);
    }
    async refresh(signal) {
        signal.throwIfAborted();
        const snapshots = await this.resolver.refreshCatalogs(signal);
        signal.throwIfAborted();
        return {
            roleCount: this.resolver.listRoles().length,
            hubs: snapshots.map(snapshot => ({
                id: snapshot.hub.id,
                source: snapshot.source,
                fetchedAt: snapshot.fetchedAt,
            })),
        };
    }
    inspectRole(selector) {
        const resolved = this.resolver.resolveRole(cleanText(selector, 'selector', 512));
        const role = this.resolver.listRoles().find(candidate => candidate.bundleDigest === resolved.bundleDigest);
        if (role === undefined) {
            throw new Error(`rolehub-bridge: resolved role ${resolved.id} is absent from the catalog view`);
        }
        return copyRoleView(role);
    }
    async listSessions(parent) {
        const bindings = await Promise.resolve(this.resolver.listSessionBindings());
        return bindings
            .filter(binding => binding.parentSessionId === parent.id)
            .map(binding => structuredClone(binding));
    }
    snapshot(parent) {
        const rooms = optionalRooms(this.ctx);
        return {
            hubs: this.listHubs(),
            roles: this.listRoles(),
            rooms: rooms === undefined ? [] : rooms.listRooms(parent, false).map(copyRoomView),
            roomAvailable: rooms !== undefined,
        };
    }
    /**
     * Install and start one pinned role through the Host-only continuable path.
     * The child id is returned as soon as its first prompt reaches its inbox.
     */
    async startRole(parent, input, signal) {
        const selector = cleanText(input.selector, 'selector', 512);
        const requestedRoomId = cleanOptionalText(input.roomId, 'room id', 240);
        const rooms = optionalRooms(this.ctx);
        if (requestedRoomId !== undefined && rooms === undefined) {
            throw new Error('rolehub-bridge: Agent Team Room is not available');
        }
        signal.throwIfAborted();
        const deployment = await this.resolver.install(selector, signal);
        assertDeploymentMatchesProvider(deployment, deployment.record.providerName);
        this.ensureProvider(deployment);
        const role = roleViewForDeployment(deployment, this.resolver.listRoles());
        const label = cleanOptionalText(input.label, 'label', 120) ?? role.displayName;
        const prompt = cleanOptionalText(input.prompt, 'prompt', 200_000)
            ?? `Join this conversation as ${role.displayName}. Briefly acknowledge the role and wait for instructions.`;
        const agentOptions = configuredAgentOptions(this.config);
        signal.throwIfAborted();
        const started = await this.ctx.subagents.startContinuable({
            provider: deployment.record.providerName,
            label,
            request: {
                parent,
                prompt: [{ type: 'text', text: prompt }],
                ...(agentOptions === undefined ? {} : { agentOptions }),
            },
            signal,
        });
        const createdAt = new Date().toISOString();
        let roomMemberId;
        try {
            signal.throwIfAborted();
            if (requestedRoomId !== undefined && rooms !== undefined) {
                const member = await rooms.attachSession(parent, requestedRoomId, {
                    sessionId: started.childId,
                    name: label,
                    profile: {
                        apiVersion: 'rolehub.dev/v1alpha1',
                        kind: 'AgentRole',
                        id: deployment.role.manifest.metadata.id,
                        version: deployment.role.manifest.metadata.version,
                        digest: `sha256:${deployment.role.bundleDigest}`,
                    },
                }, signal);
                roomMemberId = cleanText(member.memberId, 'Room member id', 240);
            }
            await this.resolver.writeSessionBinding({
                schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
                sessionId: started.childId,
                parentSessionId: parent.id,
                roleBundleDigest: deployment.role.bundleDigest,
                providerName: deployment.record.providerName,
                ...(requestedRoomId === undefined ? {} : { roomId: requestedRoomId }),
                ...(roomMemberId === undefined ? {} : { roomMemberId }),
                state: 'active',
                createdAt,
            });
        }
        catch (error) {
            await this.orphanStartedSession({
                parent,
                childId: started.childId,
                deployment,
                createdAt,
                ...(requestedRoomId === undefined ? {} : { roomId: requestedRoomId }),
                ...(roomMemberId === undefined ? {} : { roomMemberId }),
            }, error);
        }
        return {
            childId: started.childId,
            messageId: started.messageId,
            role,
            policyDigest: deployment.record.policy.policyDigest,
            ...(requestedRoomId === undefined || roomMemberId === undefined
                ? {}
                : { room: { id: requestedRoomId, memberId: roomMemberId } }),
        };
    }
    ensureProvider(deployment) {
        const name = providerNameForBundleDigest(deployment.role.bundleDigest);
        assertDeploymentMatchesProvider(deployment, name);
        const registered = this.registeredProviders.get(name);
        const live = this.ctx.subagents.getProvider(name);
        if (registered !== undefined) {
            if (live !== registered) {
                throw new Error(`rolehub-bridge: provider ${name} was unexpectedly replaced`);
            }
            return;
        }
        if (live !== undefined) {
            throw new Error(`rolehub-bridge: provider name collision for ${name}`);
        }
        const provider = new RoleHubProvider(deployment.role.bundleDigest);
        const dispose = this.ctx.subagents.registerProvider(provider);
        this.registeredProviders.set(name, provider);
        this.registryDisposers.add(() => {
            this.registeredProviders.delete(name);
            dispose();
        });
    }
    async orphanStartedSession(input, primary) {
        const failures = [primary];
        let detached = input.roomMemberId === undefined;
        if (input.roomId !== undefined && input.roomMemberId !== undefined) {
            const rooms = optionalRooms(this.ctx);
            if (rooms?.removeMember !== undefined) {
                try {
                    await rooms.removeMember(input.parent, input.roomId, input.roomMemberId, false);
                    detached = true;
                }
                catch (error) {
                    failures.push(error);
                }
            }
        }
        let interrupted = false;
        try {
            this.ctx.subagents.interrupt(input.childId, { kind: 'ancestor', agent: input.parent });
            interrupted = true;
        }
        catch (error) {
            failures.push(error);
        }
        let orphanRecorded = false;
        try {
            await this.resolver.writeSessionBinding({
                schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
                sessionId: input.childId,
                parentSessionId: input.parent.id,
                roleBundleDigest: input.deployment.role.bundleDigest,
                providerName: input.deployment.record.providerName,
                ...(input.roomId === undefined ? {} : { roomId: input.roomId }),
                ...(input.roomMemberId === undefined ? {} : { roomMemberId: input.roomMemberId }),
                state: 'orphaned',
                createdAt: input.createdAt,
            });
            orphanRecorded = true;
        }
        catch (error) {
            failures.push(error);
        }
        throw new AggregateError(failures, `rolehub-bridge: role Session ${input.childId} was created but finalization failed; `
            + `${detached ? 'Room membership was detached' : 'Room detachment was unavailable or failed'}, `
            + `${interrupted ? 'the Session was interrupted' : 'the Session interrupt failed'}, and `
            + `${orphanRecorded ? 'the orphan audit was recorded' : 'the orphan audit failed'}`);
    }
}
export default RoleHubBridgeRuntime;
function configuredAgentOptions(config) {
    const provider = config.agentProvider.trim();
    const model = config.agentModel.trim();
    if (!provider && !model)
        return undefined;
    return {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
    };
}
function optionalRooms(ctx) {
    const candidate = ctx.get('rooms');
    if (candidate === undefined || candidate === null || typeof candidate !== 'object')
        return undefined;
    const value = candidate;
    if (typeof value.attachSession !== 'function' || typeof value.listRooms !== 'function')
        return undefined;
    return value;
}
function roleViewForDeployment(deployment, catalog) {
    const view = catalog.find(candidate => candidate.bundleDigest === deployment.role.bundleDigest);
    if (view !== undefined)
        return copyRoleView({ ...view, installed: true });
    const { record, role } = deployment;
    return {
        hubId: record.hubId,
        id: role.manifest.metadata.id,
        name: role.manifest.metadata.name,
        displayName: role.manifest.metadata.displayName,
        description: role.manifest.metadata.description,
        publisher: role.manifest.metadata.publisher,
        version: role.manifest.metadata.version,
        license: role.manifest.metadata.license,
        tags: [...role.manifest.metadata.tags],
        trust: record.role.trust,
        manifestDigest: role.manifestDigest,
        bundleDigest: role.bundleDigest,
        capabilities: {
            required: role.manifest.spec.capabilities.required.map(request => request.id),
            optional: role.manifest.spec.capabilities.optional.map(request => request.id),
            denied: role.manifest.spec.capabilities.denied.map(request => request.id),
        },
        installed: true,
    };
}
function copyRoleView(role) {
    return {
        ...role,
        tags: [...role.tags],
        capabilities: {
            required: [...role.capabilities.required],
            optional: [...role.capabilities.optional],
            denied: [...role.capabilities.denied],
        },
    };
}
function copyRoomView(room) {
    return {
        id: room.id,
        name: room.name,
        ...(room.status === undefined ? {} : { status: room.status }),
    };
}
function cleanText(value, field, maximum) {
    const text = value.trim();
    if (text.length === 0)
        throw new Error(`rolehub-bridge: ${field} cannot be empty`);
    if (text.length > maximum)
        throw new Error(`rolehub-bridge: ${field} exceeds ${maximum} characters`);
    return text;
}
function cleanOptionalText(value, field, maximum) {
    if (value === undefined || value.trim().length === 0)
        return undefined;
    return cleanText(value, field, maximum);
}
class RuntimeDisposerBag {
    disposers = [];
    disposed = false;
    add(disposer) {
        if (this.disposed) {
            disposer();
            throw new Error('rolehub-bridge: runtime registry is already disposed');
        }
        this.disposers.push(disposer);
    }
    unifiedDisposer() {
        return () => this.disposeAll();
    }
    rollback(primary) {
        try {
            this.disposeAll();
        }
        catch (cleanup) {
            throw new AggregateError([primary, cleanup], 'rolehub-bridge: initialization rollback failed');
        }
        throw primary;
    }
    disposeAll() {
        if (this.disposed)
            return;
        this.disposed = true;
        const failures = [];
        for (const disposer of this.disposers.reverse()) {
            try {
                disposer();
            }
            catch (error) {
                failures.push(error);
            }
        }
        this.disposers.length = 0;
        if (failures.length === 1)
            throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, 'rolehub-bridge: runtime registry cleanup failed');
        }
    }
}
//# sourceMappingURL=index.js.map