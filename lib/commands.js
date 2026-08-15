export const name = 'rolehub-bridge-commands';
export const inject = ['commands', 'roleHubBridge'];
const USAGE = [
    '/rolehub hubs',
    '/rolehub list',
    '/rolehub refresh',
    '/rolehub inspect <selector>',
    '/rolehub start <selector> [--label "..."] [--room <id>] [--prompt "..."]',
    '/rolehub sessions',
].join('\n');
/** Tokenize Host command text without shell expansion or evaluation. */
export function tokenizeRoleHubCommand(rawInput) {
    const tokens = [];
    let token = '';
    let started = false;
    let quote;
    const finish = () => {
        if (!started)
            return;
        tokens.push(token);
        token = '';
        started = false;
    };
    for (let index = 0; index < rawInput.length; index += 1) {
        const character = rawInput[index];
        if (character === undefined)
            continue;
        if (quote === undefined && /\s/u.test(character)) {
            finish();
            continue;
        }
        if (character === '\\') {
            const escaped = rawInput[index + 1];
            if (escaped === undefined)
                throw new Error('rolehub: dangling escape at end of input');
            token += escaped;
            started = true;
            index += 1;
            continue;
        }
        if (character === '"' || character === "'") {
            if (quote === undefined) {
                quote = character;
                started = true;
                continue;
            }
            if (quote === character) {
                quote = undefined;
                continue;
            }
        }
        token += character;
        started = true;
    }
    if (quote !== undefined)
        throw new Error(`rolehub: unterminated ${quote} quote`);
    finish();
    return tokens;
}
export function parseRoleHubCommand(rawInput) {
    const tokens = tokenizeRoleHubCommand(rawInput);
    if (tokens.length === 0)
        return { action: 'list' };
    const action = tokens[0] ?? 'list';
    if (action === 'hubs' || action === 'list' || action === 'refresh' || action === 'sessions') {
        if (tokens.length !== 1)
            throw new Error(`rolehub: ${action} accepts no arguments\n${USAGE}`);
        return { action };
    }
    if (action === 'inspect') {
        if (tokens.length !== 2)
            throw new Error(`rolehub: inspect requires exactly one selector\n${USAGE}`);
        return { action, selector: required(tokens[1], 'selector') };
    }
    if (action === 'start') {
        const selector = required(tokens[1], 'selector');
        const values = flags(tokens, 2, ['--label', '--room', '--prompt']);
        const label = values.get('--label');
        const roomId = values.get('--room');
        const prompt = values.get('--prompt');
        return {
            action,
            selector,
            ...(label === undefined ? {} : { label }),
            ...(roomId === undefined ? {} : { roomId }),
            ...(prompt === undefined ? {} : { prompt }),
        };
    }
    throw new Error(`rolehub: unknown action "${action}"\n${USAGE}`);
}
/** Register the sole mutating RoleHub surface as an explicit human Host command. */
export function apply(ctx) {
    ctx.commands.register({
        name: 'rolehub',
        description: 'Discover verified RoleHub roles and explicitly start continuable role Sessions.',
        input: { hint: '[hubs | list | refresh | inspect | start | sessions]' },
        // A start prompt belongs only in the child inbox; do not duplicate it in command lifecycle events.
        recordInput: false,
        async handler(invocation) {
            try {
                const parsed = parseRoleHubCommand(invocation.rawInput);
                invocation.signal.throwIfAborted();
                switch (parsed.action) {
                    case 'hubs':
                        return jsonResult({ hubs: ctx.roleHubBridge.listHubs() });
                    case 'list':
                        return jsonResult({ roles: ctx.roleHubBridge.listRoles() });
                    case 'refresh':
                        return jsonResult(await ctx.roleHubBridge.refresh(invocation.signal));
                    case 'inspect':
                        return jsonResult({ role: ctx.roleHubBridge.inspectRole(parsed.selector) });
                    case 'start':
                        return jsonResult({
                            session: await ctx.roleHubBridge.startRole(invocation.agent, {
                                selector: parsed.selector,
                                ...(parsed.label === undefined ? {} : { label: parsed.label }),
                                ...(parsed.roomId === undefined ? {} : { roomId: parsed.roomId }),
                                ...(parsed.prompt === undefined ? {} : { prompt: parsed.prompt }),
                            }, invocation.signal),
                        });
                    case 'sessions':
                        return jsonResult({ sessions: await ctx.roleHubBridge.listSessions(invocation.agent) });
                }
            }
            catch (error) {
                return { kind: 'error', text: renderError(error) };
            }
        },
    });
}
function flags(tokens, start, allowed) {
    const result = new Map();
    for (let index = start; index < tokens.length; index += 2) {
        const flag = tokens[index];
        const value = tokens[index + 1];
        if (flag === undefined || !flag.startsWith('--')) {
            throw new Error(`rolehub: unexpected positional argument "${flag ?? ''}"\n${USAGE}`);
        }
        if (!allowed.includes(flag))
            throw new Error(`rolehub: unknown flag "${flag}"\n${USAGE}`);
        if (result.has(flag))
            throw new Error(`rolehub: duplicate flag "${flag}"`);
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`rolehub: flag "${flag}" requires a value`);
        }
        result.set(flag, required(value, `${flag} value`));
    }
    return result;
}
function required(value, field) {
    if (value === undefined || value.trim().length === 0) {
        throw new Error(`rolehub: ${field} is required\n${USAGE}`);
    }
    return value;
}
function jsonResult(value) {
    return { kind: 'success', text: JSON.stringify(value, null, 2) };
}
function renderError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=commands.js.map