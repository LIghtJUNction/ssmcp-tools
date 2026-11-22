// SSMCP tool sources, MIT licensed. Evaluated only in the bounded SSMCP VM.
// A factory returns named helper exports; host authorization remains in SSMCP.
(core => {
  'use strict';
  const {call, dispatch, digest, clients} = core;
  const parse = JSON.parse, stringify = JSON.stringify, freeze = Object.freeze;
  const keys = Object.keys, isArray = Array.isArray, text = String, Failure = Error;
  // Future client tools need no relay helper or provider-name update.
  // This object only constructs names; the live client registry remains authoritative.
  const NativeProxy = Proxy;
  const nativeApi = id => {
    if (typeof id !== 'string' || !id || id.length > 128) {
      throw new Failure('native() requires a client ID');
    }
    const path = name => new NativeProxy(() => {}, {
      get: (_target, key) => {
        if (key === 'then' || key === 'toJSON' || typeof key !== 'string') return undefined;
        if (!/^[A-Za-z0-9_-]+$/.test(key) || ['constructor','prototype','__proto__'].includes(key)) {
          throw new Failure('invalid native API component');
        }
        const next = name ? name + '.' + key : key;
        if (next.length > 128) throw new Failure('native tool name exceeds 128 bytes');
        return path(next);
      },
      apply: (_target, _this, args) => {
        if (!name || args.length > 1) throw new Failure('native calls accept one argument object');
        return call(id, name, args[0] === undefined ? {} : args[0]);
      },
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
      setPrototypeOf: () => false,
    });
    return path('');
  };
  const capabilities = id => call(id, 'ssmcp.client.capabilities', {});
  const computer = freeze(Object.fromEntries(
    ['version','download','install','uninstall']
      .map(name => [name, (id, args = {}) => call(id, 'ssmcp.computer.' + name, args)])
  ));
  const tools = async (id, cursor = null) => {
    if (cursor !== null && typeof cursor !== 'string') {
      throw new Failure('tool cursor must be a string or null');
    }
    return dispatch('tools', id, '', cursor);
  };

  // Search is a bounded view over the existing authorized catalog pages. It
  // reduces returned text; it does not add a second registry or bypass host
  // authorization, and it does not reduce the first underlying page scan.
  const searchUtf8Bytes = value => {
    let count = 0;
    for (const ch of value) {
      const code = ch.codePointAt(0);
      count += code > 0xffff ? 4 : code > 0x7ff ? 3 : code > 0x7f ? 2 : 1;
    }
    return count;
  };
  const searchCursorValid = value => value === null
    || (typeof value === 'string' && value.length > 0 && searchUtf8Bytes(value) <= 128);
  const searchSnippet = description => {
    if (typeof description !== 'string') return {description:'', description_truncated:false};
    const flat = description.replace(/\s+/gu, ' ').trim();
    let short = '', count = 0;
    for (const ch of flat) {
      if (count++ === 240) return {description:short + '…', description_truncated:true};
      short += ch;
    }
    return {description:short, description_truncated:false};
  };
  const searchTools = async (id, options = {}) => {
    if (typeof id !== 'string' || !id || searchUtf8Bytes(id) > 128) {
      throw new Failure('tools.search requires a client ID of at most 128 UTF-8 bytes');
    }
    if (!options || typeof options !== 'object' || isArray(options)
        || keys(options).some(key => !['query','name_prefix','limit','include_schemas','cursor','max_pages'].includes(key))) {
      throw new Failure('tools.search accepts query, name_prefix, limit, include_schemas, cursor and max_pages');
    }
    const query = options.query === undefined ? '' : options.query;
    const namePrefix = options.name_prefix === undefined ? '' : options.name_prefix;
    const limit = options.limit === undefined ? 20 : options.limit;
    const includeSchemas = options.include_schemas === undefined ? false : options.include_schemas;
    const maxPages = options.max_pages === undefined ? 32 : options.max_pages;
    if (typeof query !== 'string' || searchUtf8Bytes(query) > 256) {
      throw new Failure('tools.search query must be a string of at most 256 UTF-8 bytes');
    }
    if (typeof namePrefix !== 'string' || !/^[A-Za-z0-9_.-]{0,128}$/u.test(namePrefix)) {
      throw new Failure('tools.search name_prefix must contain at most 128 registered-name characters: A-Z, a-z, 0-9, _, . or -');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Failure('tools.search limit must be 1..=50');
    }
    if (typeof includeSchemas !== 'boolean') {
      throw new Failure('tools.search include_schemas must be a boolean');
    }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 32) {
      throw new Failure('tools.search max_pages must be 1..=32');
    }
    const needle = query.trim().toLowerCase();
    const prefix = namePrefix.toLowerCase();
    let cursor = null, offset = 0, expectedPageHash = null, totalScanned = 0;
    let visited = [];
    if (options.cursor !== undefined && options.cursor !== null) {
      if (typeof options.cursor !== 'string' || searchUtf8Bytes(options.cursor) > 12 * 1024) {
        throw new Failure('tools.search cursor must be a returned string of at most 12 KiB');
      }
      let state;
      try { state = parse(options.cursor); }
      catch { throw new Failure('invalid tools.search cursor; restart the search'); }
      const fields = ['v','client','query','limit','include_schemas','page','offset','page_hash','visited','scanned'];
      if (prefix) fields.push('name_prefix');
      if (!state || typeof state !== 'object' || isArray(state)
          || keys(state).length !== fields.length
          || keys(state).some(key => !fields.includes(key))
          || state.v !== (prefix ? 2 : 1) || (prefix && state.name_prefix !== prefix)
          || state.client !== id || state.query !== needle
          || state.limit !== limit || state.include_schemas !== includeSchemas
          || !searchCursorValid(state.page)
          || !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > 64
          || !(state.page_hash === null || (typeof state.page_hash === 'string' && /^[a-f0-9]{64}$/u.test(state.page_hash)))
          || (state.offset > 0 && state.page_hash === null)
          || !Number.isSafeInteger(state.scanned) || state.scanned < 0 || state.scanned > 8192
          || !isArray(state.visited) || state.visited.length > 127
          || state.visited.some(value => !searchCursorValid(value))
          || new Set(state.visited).size !== state.visited.length
          || state.visited.includes(state.page)) {
        throw new Failure('tools.search cursor does not match this client, query or options; restart the search');
      }
      cursor = state.page;
      offset = state.offset;
      expectedPageHash = state.page_hash;
      visited = state.visited;
      totalScanned = state.scanned;
    }
    const matches = [];
    let itemBytes = 2, pagesRead = 0, scanned = 0;
    const result = (complete, reason, pageHash = null) => {
      const continuation = complete ? null : stringify({
        v:prefix ? 2 : 1, ...(prefix ? {name_prefix:prefix} : {}),
        client:id, query:needle, limit, include_schemas:includeSchemas,
        page:cursor, offset, page_hash:pageHash, visited, scanned:totalScanned,
      });
      if (continuation !== null && searchUtf8Bytes(continuation) > 12 * 1024) {
        throw new Failure('tools.search continuation exceeds 12 KiB; use the original tools() pagination');
      }
      const value = {
        tools:matches, nextCursor:continuation, complete, stopped_reason:reason,
        include_schemas:includeSchemas, namespace_source:'registered_tool_name',
        ...(prefix ? {name_prefix:prefix} : {}),
        stats:{pages_read:pagesRead, tools_scanned:scanned, total_tools_scanned:totalScanned},
      };
      if (searchUtf8Bytes(stringify(value)) > 128 * 1024) {
        throw new Failure('tools.search output exceeds 128 KiB; reduce limit or use the original tools() pagination');
      }
      return value;
    };
    for (;;) {
      if (visited.includes(cursor)) throw new Failure('tools.search detected a repeated native cursor');
      // Every page, including a resumed page, re-enters the host tools path.
      // The host checks the current client connection and authorization again.
      const page = await tools(id, cursor);
      pagesRead++;
      if (!page || typeof page !== 'object' || isArray(page)
          || !isArray(page.tools) || page.tools.length > 64
          || !searchCursorValid(page.nextCursor ?? null)) {
        throw new Failure('tools.search received an invalid native catalog page');
      }
      const pageHash = digest(stringify(page));
      if (typeof pageHash !== 'string' || pageHash.length !== 64) {
        throw new Failure('tools.search native catalog digest exceeds its bounded input');
      }
      if (expectedPageHash !== null && pageHash !== expectedPageHash) {
        throw new Failure('tools.search catalog changed while resuming; restart the search');
      }
      if (offset > page.tools.length) {
        throw new Failure('tools.search cursor offset is outside the native page; restart the search');
      }
      const next = page.nextCursor ?? null;
      if (next !== null && (next === cursor || visited.includes(next))) {
        throw new Failure('tools.search detected a repeated native cursor');
      }
      while (offset < page.tools.length) {
        if (totalScanned >= 8192) {
          throw new Failure('tools.search exceeds 8192 scanned tools; use the original tools() pagination');
        }
        const descriptor = page.tools[offset];
        if (!descriptor || typeof descriptor !== 'object' || isArray(descriptor)
            || typeof descriptor.name !== 'string'
            || !/^[A-Za-z0-9_.-]{1,128}$/u.test(descriptor.name)) {
          throw new Failure('tools.search received an invalid native tool descriptor');
        }
        const description = typeof descriptor.description === 'string' ? descriptor.description : '';
        const name = descriptor.name.toLowerCase();
        const match = name.startsWith(prefix)
          && (!needle || name.includes(needle) || description.toLowerCase().includes(needle));
        if (match) {
          const parts = descriptor.name.split('.');
          // This is the observed routing namespace, not an invented provider ID.
          const namespace = parts[0] === 'ssmcp' ? parts.slice(0, 2).join('.') : parts[0];
          const item = includeSchemas ? descriptor
            : {name:descriptor.name, namespace, ...searchSnippet(description)};
          const size = searchUtf8Bytes(stringify(item)) + (matches.length ? 1 : 0);
          if (size + 2 > 96 * 1024) {
            throw new Failure('tools.search native descriptor exceeds its 96 KiB item budget; retrieve the unchanged descriptor with tools(clientId, nativeCursor) instead');
          }
          if (itemBytes + size > 96 * 1024) return result(false, 'output_budget', pageHash);
          matches.push(item);
          itemBytes += size;
        }
        offset++;
        scanned++;
        totalScanned++;
        if (matches.length >= limit && offset < page.tools.length) {
          return result(false, 'limit', pageHash);
        }
      }
      visited.push(cursor);
      cursor = next;
      offset = 0;
      expectedPageHash = null;
      if (cursor === null) return result(true, null);
      if (visited.length >= 128) {
        throw new Failure('tools.search exceeds 128 catalog pages; use the original tools() pagination');
      }
      if (matches.length >= limit) return result(false, 'limit');
      if (pagesRead >= maxPages) return result(false, 'page_budget');
    }
  };
  Object.defineProperty(tools, 'search', {value:searchTools, enumerable:true});
  freeze(tools);

  const builtin = (name, args = {}) => dispatch('builtin', '_', name, args);
  const collab = freeze(Object.fromEntries(
    ['join', 'list', 'update', 'send', 'receive', 'ack', 'leave', 'bind'].map(action => [
      action, (clientId, args = {}) => {
        if (!args || typeof args !== 'object' || isArray(args)) {
          throw new Failure('collab arguments must be an object');
        }
        if (action === 'receive' && (args.wait_ms ?? 0) > 1000) {
          throw new Failure('Use the direct collab tool for wait_ms above 1000; it does not occupy a code_mode worker');
        }
        return builtin('collab.' + action, {...args, client_id: clientId});
      }
    ])
  ));
  const messages = freeze(Object.fromEntries(
    ['list', 'send', 'broadcast', 'status', 'inbox', 'ack'].map(action => [action, (clientId, args = {}) => {
      if (!args || typeof args !== 'object' || isArray(args) || 'action' in args) {
        throw new Failure('messages arguments must be an object without action');
      }
      return builtin('messages.' + action, {...args, client_id: clientId});
    }])
  ));
  const workspaceResult = async (id, name, args = {}) => {
    const reply = await call(id, name, args);
    if (reply.isError) {
      const detail = reply.content?.find(item => item.type === 'text')?.text;
      throw new Failure(typeof detail === 'string' ? detail.slice(0, 4096) : name + ' failed');
    }
    if (!reply.structuredContent) throw new Failure(name + ' returned no structured result');
    return reply.structuredContent;
  };
  const file = (name, id, args) => workspaceResult(id, 'ssmcp.fs.' + name, args);
  const reload = id => workspaceResult(id, 'ssmcp.client.reload');
  const say = (id, message) => workspaceResult(id, 'ssmcp.ui.message',
    typeof message === 'string' ? {text: message} : message);
  const advertisesThreadEvents = descriptor => {
    const acceptsThread = schema => {
      const action = schema?.properties?.action;
      return action?.const === 'thread'
        || (isArray(action?.enum) && action.enum.includes('thread'));
    };
    const schema = descriptor?.inputSchema;
    return acceptsThread(schema)
      || (isArray(schema?.oneOf) && schema.oneOf.some(acceptsThread));
  };
  const threadEventsTool = async id => {
    let cursor = null, legacy = false, eventsAdvertised = false;
    const visited = new Set();
    for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
      if (visited.has(cursor)) throw new Failure('ui.events catalog repeated a cursor');
      visited.add(cursor);
      const page = await tools(id, cursor);
      if (!page || typeof page !== 'object' || isArray(page)
          || !isArray(page.tools) || page.tools.length > 64
          || !searchCursorValid(page.nextCursor ?? null)) {
        throw new Failure('ui.events received an invalid native catalog page');
      }
      for (const descriptor of page.tools) {
        if (descriptor?.name === 'ssmcp.ui.events') {
          eventsAdvertised = true;
          if (advertisesThreadEvents(descriptor)) return 'ssmcp.ui.events';
        } else if (descriptor?.name === 'ssmcp.ui.history'
            && advertisesThreadEvents(descriptor)) {
          legacy = true;
        }
      }
      cursor = page.nextCursor ?? null;
      if (cursor === null) {
        if (!eventsAdvertised && legacy) return 'ssmcp.ui.history';
        throw new Failure('the selected client does not advertise live thread events; update that client');
      }
    }
    throw new Failure('ui.events could not finish bounded capability discovery');
  };
  const liveEvents = async (id, args = {}) => {
    if (typeof id !== 'string' || !id || searchUtf8Bytes(id) > 128) {
      throw new Failure('ui.events requires a client ID of at most 128 UTF-8 bytes');
    }
    if (!args || typeof args !== 'object' || isArray(args)
        || keys(args).some(key => ![
          'action', 'client_id', 'agent_id', 'main', 'cursor', 'generation', 'limit',
        ].includes(key))) {
      throw new Failure('ui.events accepts only live thread selectors and paging fields');
    }
    if (Object.hasOwn(args, 'action') && args.action !== 'thread') {
      throw new Failure('ui.events only supports action thread');
    }
    if (Object.hasOwn(args, 'client_id') && args.client_id !== id) {
      throw new Failure('ui.events client_id must match the selected client');
    }
    // Capability discovery chooses the one compatible read. Authorization,
    // native errors and incomplete catalogs never trigger a second tool call.
    const name = await threadEventsTool(id);
    return workspaceResult(id, name, {...args, action:'thread', client_id:id});
  };
  const ui = freeze({ ...Object.fromEntries(
    ['get', 'set', 'action', 'filter', 'queue', 'message', 'present', 'ask', 'questions', 'harness'].map(name =>
      [name, (id, args = {}) => workspaceResult(id, 'ssmcp.ui.' + name, args)])
  ), events: liveEvents, wait: (id, args = {}) => dispatch('wait_user', id, 'wait', args) });
  const sessions = freeze(Object.fromEntries(
    ['list', 'status', 'create', 'restart', 'close'].map(name =>
      [name, (id, args = {}) => workspaceResult(id, 'ssmcp.session.' + name, args)])
  ));
  const outputs = freeze({
    read: (id, args) => workspaceResult(id, 'ssmcp.output.read', args),
    stat: (id, args) => workspaceResult(id, 'ssmcp.output.stat', args),
    cleanup: id => workspaceResult(id, 'ssmcp.output.cleanup'),
  });
  const fs = freeze({
    list: (id, args) => file('list', id, args),
    stat: (id, args) => file('stat', id, args),
    read: (id, args) => file('read', id, args),
    write: (id, args) => file('write', id, args),
    mkdir: (id, args) => file('mkdir', id, args),
    readText: (id, args) => file('read_text', id, args),
    writeText: (id, args) => file('write_text', id, args),
    editText: (id, args) => file('edit_text', id, args),
  });
  // Workspace roots remain available; retired memory operations are not helpers.
  const context = freeze({
    roots: id => workspaceResult(id, 'ssmcp.context.roots'),
  });
  const skills = freeze({
    list: (id, args) => workspaceResult(id, 'ssmcp.skills.list', args),
    read: (id, args) => workspaceResult(id, 'ssmcp.skills.read', args),
    view: (id, args = {}) => {
      if (args && typeof args === 'object' && !isArray(args)
          && args.root === undefined && args.scope === undefined) {
        args = {...args, scope:'effective'};
      }
      return workspaceResult(id, 'ssmcp.skills.view', args);
    },
  });
  const agents = freeze({
    list: (id, args) => workspaceResult(id, 'ssmcp.agents.list', args),
    read: (id, args) => workspaceResult(id, 'ssmcp.agents.read', args),
    resolve: (id, args) => workspaceResult(id, 'ssmcp.agents.resolve', args),
  });
  const execution = (name, id, args) => workspaceResult(id, 'ssmcp.exec.' + name, args);
  const commandOptions = (args, defaultMaxBytes = 16384) => {
    if (!args || typeof args !== 'object' || isArray(args)) {
      throw new Failure('exec.run requires a command options object');
    }
    // Preserve native start options, including the optional display-only title.
    // The client validates title; helpers never infer it from inline script text.
    const {wait_ms = 5000, max_bytes = defaultMaxBytes, ...startArgs} = args;
    if (!Number.isSafeInteger(wait_ms) || wait_ms < 0 || wait_ms > 60000) {
      throw new Failure('exec.run wait_ms must be 0..=60000; it never cancels the command');
    }
    if (!Number.isSafeInteger(max_bytes) || max_bytes < 1 || max_bytes > 32768) {
      throw new Failure('exec.run max_bytes must be 1..=32768 per stream');
    }
    return {wait_ms, max_bytes, startArgs};
  };
  const executePreparedCommand = async (id, {wait_ms, max_bytes, startArgs}) => {
    const started = await execution('start', id, startArgs);
    const job = started.job_id;
    if (typeof job !== 'string' || !job) {
      throw new Failure('Command start returned no job_id; inspect exec.list before retrying');
    }
    try {
      const status = wait_ms === 0 ? started : await execution('wait', id, {job_id:job, wait_ms});
      const output = await execution('read', id, {job_id:job, max_bytes});
      const snapshot = output.snapshot ?? status;
      return {...status, ...snapshot, ...output, snapshot};
    } catch (error) {
      const failure = new Failure('Command started as ' + job + '; ' + (error?.message ?? text(error))
        + '. Inspect exec.status/exec.read for this job before retrying.');
      failure.job_id = job;
      throw failure;
    }
  };
  const executeCommand = async (id, args) => executePreparedCommand(id, commandOptions(args));
  const parallelCommands = async (id, commands, options = {}) => {
    if (!isArray(commands) || commands.length > 32) {
      throw new Failure('exec.parallel accepts an array of at most 32 command options objects');
    }
    if (!options || typeof options !== 'object' || isArray(options)
        || keys(options).some(key => key !== 'concurrency')) {
      throw new Failure('exec.parallel options only accept concurrency');
    }
    const concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      throw new Failure('exec.parallel concurrency must be 1..=8');
    }
    const results = new Array(commands.length);
    let next = 0;
    const worker = async () => {
      while (next < commands.length) {
        const index = next++;
        let prepared;
        try {
          prepared = commandOptions(commands[index], 2048);
        } catch (error) {
          results[index] = {
            status:'rejected', not_started:true,
            reason:(error?.message ?? text(error)).slice(0, 4096),
          };
          continue;
        }
        let job;
        try {
          let value = await executePreparedCommand(id, prepared);
          job = value.job_id;
          // A polling deadline never frees a running process's concurrency slot.
          while (value.running === true) {
            const status = await execution('wait', id, {job_id:job, wait_ms:60000});
            if (typeof status.running !== 'boolean') {
              throw new Failure('command state is unavailable; inspect exec.list before starting more work');
            }
            value = {...value, ...status, snapshot:status};
            if (!status.running) {
              const output = await execution('read', id, {
                job_id:job, max_bytes:prepared.max_bytes,
              });
              value = {...value, ...output.snapshot, ...output, snapshot:output.snapshot ?? status};
            }
          }
          if (value.running !== false) {
            throw new Failure('command completion is unknown; inspect exec.list before starting more work');
          }
          results[index] = {status:'fulfilled', value};
        } catch (error) {
          const job_id = job ?? error?.job_id;
          results[index] = {
            status:'rejected', reason:(error?.message ?? text(error)).slice(0, 4096),
            ...(job_id ? {job_id} : {}),
          };
          // Observation can fail after launch. Reserve this worker's slot for
          // that possibly running process instead of oversubscribing the host.
          return;
        }
      }
    };
    await Promise.all(Array.from({length:Math.min(concurrency, commands.length)}, worker));
    for (let index = 0; index < results.length; index++) {
      if (!results[index]) results[index] = {
        status:'rejected', not_started:true,
        reason:'Command was not started because a worker could not confirm completion; inspect returned job IDs before retrying.',
      };
    }
    return results;
  };
  const executionJob = async (name, id, job, args) => {
    if (typeof job === 'string') {
      if (args === undefined) args = {};
      if (!args || typeof args !== 'object' || isArray(args)) {
        throw new Failure('exec.' + name + ' options must be a JSON object');
      }
      args = {...args, job_id:job};
    } else {
      if (args !== undefined) {
        throw new Failure('exec.' + name + ' takes either a job options object or a job ID and options');
      }
      args = job;
    }
    if (!args || typeof args !== 'object' || isArray(args)
        || typeof args.job_id !== 'string' || !args.job_id) {
      throw new Failure('exec.' + name + ' requires a nonempty job ID or an options object with job_id');
    }
    return execution(name, id, args);
  };
  const exec = freeze({
    start: (id, args) => execution('start', id, args),
    list: id => execution('list', id),
    status: (id, job, args) => executionJob('status', id, job, args),
    wait: (id, job, args) => executionJob('wait', id, job, args),
    read: (id, job, args) => executionJob('read', id, job, args),
    write: (id, job, args) => executionJob('write', id, job, args),
    cancel: (id, job, args) => executionJob('cancel', id, job, args),
    forget: (id, job, args) => executionJob('forget', id, job, args),
    events: (id, args) => execution('events', id, args),
    run: executeCommand,
    parallel: parallelCommands,
  });
  // Explicit RTK argv: the same execution/approval path as exec, never a shell
  // rewrite, implicit installation or retry without filtering. The output is
  // RTK's output; its recall/tee hints remain intact for recovery.
  const rtkCommand = (args, running) => {
    const allowed = ['command', 'cwd', 'env', 'stdin', 'timeout_ms'];
    if (running) allowed.push('wait_ms', 'max_bytes');
    if (!args || typeof args !== 'object' || isArray(args)
        || keys(args).some(key => !allowed.includes(key))) {
      throw new Failure('rtk.' + (running ? 'run' : 'start')
        + ' accepts ' + allowed.join(', '));
    }
    const command = args.command;
    if (!isArray(command) || !command.length || command.length > 255
        || command.some(arg => typeof arg !== 'string' || arg.includes(String.fromCharCode(0)))
        || !command[0]) {
      throw new Failure('rtk command must contain 1..=255 literal argv strings, without the rtk prefix');
    }
    return {...args, command:['rtk', ...command]};
  };
  const rtkStatus = async (id, args = {}) => {
    if (!args || typeof args !== 'object' || isArray(args)
        || keys(args).some(key => !['cwd', 'env'].includes(key))) {
      throw new Failure('rtk.status accepts cwd and env');
    }
    let probe;
    try {
      probe = await executeCommand(id, {
        ...args, command:['rtk', '--version'], timeout_ms:5000, wait_ms:5000, max_bytes:1024,
      });
    } catch (error) {
      // Only a native spawn failure proves RTK cannot run. Authorization and
      // connection failures must stay errors, with any launched job_id intact.
      if (!error?.job_id && error?.message?.startsWith('could not start command:')) {
        return {available:false, version:null, error:error.message};
      }
      throw error;
    }
    const version = typeof probe.stdout === 'string'
      ? probe.stdout.trim().split(String.fromCharCode(10))[0] : '';
    return {
      ...probe,
      available:probe.running === true ? null : probe.exit_code === 0 && /^rtk\s+/.test(version),
      version:/^rtk\s+/.test(version) ? version : null,
    };
  };
  const rtk = freeze({
    status: rtkStatus,
    start: async (id, args) => execution('start', id, rtkCommand(args, false)),
    run: async (id, args) => executeCommand(id, rtkCommand(args, true)),
  });
  const terminal = freeze(Object.fromEntries(
    ['open','list','select','close','read','write','status','resize']
      .map(name => [name, (id, args = {}) => workspaceResult(id, 'terminal.' + name, args)])
  ));
  const rsync = (args) => builtin('sync', args);
  const jobs = freeze({
    list: () => builtin('jobs.list'),
    status: id => builtin('jobs.status', {id}),
    wait: (id, args = {}) => builtin('jobs.wait', {...args, id}),
    cancel: id => builtin('jobs.cancel', {id}),
  });
  const waitFor = freeze(Object.assign(
    (id, args = {}) => builtin('await', {...args, client_id: id}),
    {cancel: (id, waitId) => builtin('await', {client_id: id, op: 'cancel', wait_id: waitId})}
  ));
  const ports = freeze({
    open: args => builtin('ports.open', args),
    list: () => builtin('ports.list'),
    close: id => builtin('ports.close', {id}),
  });
  const resources = freeze({
    list: (cursor = null) => builtin('resources.list', {cursor}),
    read: uri => builtin('resources.read', {uri}),
    templates: () => builtin('resources.templates'),
    forClient: id => freeze({
      list: (args = {}) => workspaceResult(id, 'ssmcp.resources.list', args),
      read: uri => workspaceResult(id, 'ssmcp.resources.read', {uri}),
      templates: (args = {}) => workspaceResult(id, 'ssmcp.resources.templates', args),
    }),
  });
  const workers = freeze(Object.fromEntries(
    ['status','submit','result','cancel']
      .map(name => [name, (id, args = {}) => workspaceResult(id, 'ssmcp.worker.' + name, args)])
  ));
  return {
    native: nativeApi,
    capabilities,
    tools,
    computer,
    reload,
    say,
    ui,
    sessions,
    collab,
    messages,
    outputs,
    fs,
    context,
    skills,
    agents,
    exec,
    rtk,
    terminal,
    rsync,
    sync: rsync,
    jobs,
    waitFor,
    ports,
    resources,
    workers,
  };
})
