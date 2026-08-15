import { createDsharnessSetup } from '@ishuowang/rolehub-compat-dsharness';
import { foldSubagentDescriptor, } from '@deepseek-ai/dsh-subagent';
import { createGitReadTool } from './git-tool.js';
import { assertEffectivePolicy } from './policy.js';
import { ROLEHUB_PROVIDER_PREFIX, } from './types.js';
export function providerNameForBundleDigest(bundleDigest) {
    if (!/^[a-f0-9]{64}$/u.test(bundleDigest)) {
        throw new Error('rolehub-bridge: bundle digest must be 64 lowercase hexadecimal characters');
    }
    return `${ROLEHUB_PROVIDER_PREFIX}${bundleDigest}`;
}
/**
 * Role providers exist only to reserve a durable descriptor for continuable
 * Sessions. The ordinary one-shot subagent path is deliberately unavailable.
 */
export class RoleHubProvider {
    bundleDigest;
    name;
    capabilities = {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
    };
    inheritsParentContext = false;
    constructor(bundleDigest, name = providerNameForBundleDigest(bundleDigest)) {
        this.bundleDigest = bundleDigest;
        this.name = name;
        if (name !== providerNameForBundleDigest(bundleDigest)) {
            throw new Error('rolehub-bridge: provider name must be derived from its exact bundle digest');
        }
    }
    async start(_request) {
        throw new Error(`rolehub-bridge: provider ${this.name} rejects one-shot reuse; start the role through the Host /rolehub start command`);
    }
    async prepareContinuable(request) {
        request.signal.throwIfAborted();
        return {};
    }
}
/**
 * Build the single global continuation contribution. Non-RoleHub children are
 * untouched; RoleHub children are re-bound from their durable provider digest.
 */
export function createRoleHubContinuableSetup(deployments) {
    return (childCtx) => {
        const agent = childCtx.agent;
        if (agent === undefined) {
            throw new Error('rolehub-bridge: continuable setup requires an unpublished child Agent');
        }
        const descriptor = foldSubagentDescriptor(agent.session.events);
        if (descriptor === undefined || !descriptor.provider.startsWith(ROLEHUB_PROVIDER_PREFIX)) {
            return () => undefined;
        }
        if (descriptor.mode !== 'continuable') {
            throw new Error('rolehub-bridge: a RoleHub provider descriptor must be continuable');
        }
        const deployment = deployments.getDeployment(descriptor.provider);
        if (deployment === undefined) {
            throw new Error(`rolehub-bridge: no verified deployment exists for provider ${descriptor.provider}`);
        }
        assertDeploymentMatchesProvider(deployment, descriptor.provider);
        const registry = childCtx;
        const collected = new RegistryDisposerFacade(registry);
        try {
            if (deployment.record.policy.grants.includes('source-control.read')) {
                collected.registerTool(createGitReadTool());
            }
            createDsharnessSetup(deployment.role, {
                mode: 'strict',
                scope: 'session',
                policy: deployment.record.policy,
                bindings: deployment.record.bindings,
            })(collected.context);
            return collected.unifiedDisposer();
        }
        catch (error) {
            return collected.rollback(error);
        }
    };
}
export function assertDeploymentMatchesProvider(deployment, providerName) {
    const { record, role } = deployment;
    const expectedProvider = providerNameForBundleDigest(role.bundleDigest);
    if (providerName !== expectedProvider || record.providerName !== expectedProvider) {
        throw new Error('rolehub-bridge: deployment provider does not match the loaded bundle digest');
    }
    if (record.role.bundleDigest !== role.bundleDigest
        || record.role.manifestDigest !== role.manifestDigest
        || record.role.id !== role.manifest.metadata.id
        || record.role.name !== role.manifest.metadata.name
        || record.role.version !== role.manifest.metadata.version) {
        throw new Error('rolehub-bridge: deployment receipt no longer matches the loaded role');
    }
    assertEffectivePolicy(role, record.policy, record.bindings);
}
/** Captures every compatibility registration and exposes exactly one teardown. */
class RegistryDisposerFacade {
    registry;
    disposers = [];
    disposed = false;
    context;
    constructor(registry) {
        this.registry = registry;
        this.context = {
            systemPrompt: {
                section: section => this.collect(registry.systemPrompt.section(section)),
            },
            skills: {
                register: skill => this.collect(registry.skills.register(skill)),
            },
            tools: {
                restrict: filter => this.collect(registry.tools.restrict(filter)),
                guard: guard => this.collect(registry.tools.guard(guard)),
            },
        };
    }
    registerTool(tool) {
        this.collect(this.registry.tools.register(tool));
    }
    unifiedDisposer() {
        return () => this.disposeAll();
    }
    rollback(primary) {
        try {
            this.disposeAll();
        }
        catch (cleanup) {
            throw new AggregateError([primary, cleanup], 'rolehub-bridge: role setup and registry rollback both failed');
        }
        throw primary;
    }
    collect(disposer) {
        if (this.disposed) {
            disposer();
            throw new Error('rolehub-bridge: cannot register into a disposed Activation facade');
        }
        if (typeof disposer !== 'function') {
            throw new Error('rolehub-bridge: a child registry did not return a disposer');
        }
        this.disposers.push(disposer);
        return disposer;
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
            throw new AggregateError(failures, 'rolehub-bridge: multiple child registry disposers failed');
        }
    }
}
//# sourceMappingURL=provider.js.map