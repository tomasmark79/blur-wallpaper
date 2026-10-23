// Exercise wallpaper selection and async lifecycle without touching a live Shell.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(`${__dirname}/../extension.js`, 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class', 'globalThis.BlurWallpaperExtension = class');

class Settings {
    constructor(values) {
        this.values = {...values};
        this.handlers = [];
    }
    get_string(key) { return this.values[key]; }
    get_int(key) { return this.values[key]; }
    get_boolean(key) { return this.values[key]; }
    get_enum(key) { return this.values[key]; }
    set_string(key, value) { this.set(key, value); }
    set(key, value) {
        if (this.values[key] === value) return;
        this.values[key] = value;
        for (const [signal, callback] of this.handlers)
            if (signal === `changed::${key}`) callback();
    }
    connectObject(...args) {
        for (let i = 0; i < args.length - 1; i += 2)
            this.handlers.push([args[i], args[i + 1]]);
    }
    disconnectObject() { this.handlers = []; }
}

function fixture({desktop = 0, overview = true, intensity = 30} = {}) {
    const settings = new Settings({intensity: desktop,
        'overview-wallpaper': overview, 'overview-intensity': intensity});
    const bg = new Settings({'picture-uri': 'file:///light.jpg',
        'picture-uri-dark': 'file:///dark.jpg', 'picture-options': 5,
        'primary-color': '#000000', 'secondary-color': '#ffffff', 'color-shading-type': 0});
    const iface = new Settings({'color-scheme': 'default'});
    const group = {children: [], insert_child_at_index(actor, index) {
        this.children.splice(index, 0, actor);
    }};
    const layout = new Settings({});
    layout.monitors = [{index: 0, x: 0, y: 0, width: 1920, height: 1080},
        {index: 1, x: -1280, y: 0, width: 1280, height: 1024}];
    layout.overviewGroup = group;
    class Background {
        set_file(file, style) { this.uri = file?.uri; this.style = style; }
        set_color(color) { this.color = color; }
        set_gradient(...args) { this.gradient = args; }
    }
    class Actor {
        constructor(props) { Object.assign(this, props); this.content = {}; }
        set_position(x, y) { this.position = [x, y]; }
        set_size(w, h) { this.size = [w, h]; }
        destroy() { group.children = group.children.filter(a => a !== this); }
    }
    const context = vm.createContext({console, GLib: {
        build_filenamev: parts => parts.join('/'), get_user_cache_dir: () => '/cache',
    }, Gio: {
        Settings: function ({schema}) {
            return schema.endsWith('.background') ? bg : iface;
        },
        File: {new_for_uri: uri => ({uri}), new_for_path: path => ({get_uri: () => `file://${path}`})},
    }, Clutter: {}, Cogl: {Color: {from_string: color => [true, color]}},
    Meta: {Background, BackgroundActor: Actor}, Main: {layoutManager: layout},
    global: {display: {}}, Extension: class {getSettings() { return settings; }}});
    vm.runInContext(source, context);
    const extension = new context.BlurWallpaperExtension();
    const jobs = [];
    extension._createBlurredImage = (uri, sigma) => new Promise(resolve => {
        jobs.push({uri, sigma, resolve: () => resolve(`file:///cache/${sigma}-${uri.split('/').pop()}`)});
    });
    extension.enable();
    return {extension, settings, bg, iface, layout, group, jobs, context};
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('failed conversions keep each appearance independent on desktop and overview', async () => {
    for (const failed of ['light', 'dark']) {
        const f = fixture({overview: false});
        f.extension._createBlurredImage = async uri => uri.includes(failed)
            ? null : `file:///cache/blurred-${uri.split('/').pop()}`;
        f.settings.set('intensity', 120);
        await tick();
        assert.equal(f.bg.get_string('picture-uri'), failed === 'light'
            ? 'file:///light.jpg' : 'file:///cache/blurred-light.jpg');
        assert.equal(f.bg.get_string('picture-uri-dark'), failed === 'dark'
            ? 'file:///dark.jpg' : 'file:///cache/blurred-dark.jpg');
        f.settings.set('overview-wallpaper', true);
        await tick();
        f.iface.set('color-scheme', 'prefer-dark');
        await tick();
        assert.equal(f.extension._overviewBackground.uri, failed === 'dark'
            ? 'file:///dark.jpg' : 'file:///cache/blurred-dark.jpg');
        f.extension.disable();
        assert.equal(f.bg.get_string('picture-uri'), 'file:///light.jpg');
        assert.equal(f.bg.get_string('picture-uri-dark'), 'file:///dark.jpg');
    }
});

test('empty wallpaper variants are preserved and do not block the other image', async () => {
    for (const emptyKey of ['picture-uri', 'picture-uri-dark']) {
        const f = fixture({overview: false});
        f.bg.set(emptyKey, '');
        f.extension._createBlurredImage = async uri => `file:///cache/blurred-${uri.split('/').pop()}`;
        f.settings.set('intensity', 120);
        await tick();
        assert.equal(f.bg.get_string(emptyKey), '');
        const otherKey = emptyKey === 'picture-uri' ? 'picture-uri-dark' : 'picture-uri';
        assert.match(f.bg.get_string(otherKey), /cache\/blurred-/);
        f.extension.disable();
        assert.equal(f.bg.get_string(emptyKey), '');
        assert.equal(f.bg.get_string(otherKey), otherKey === 'picture-uri'
            ? 'file:///light.jpg' : 'file:///dark.jpg');
    }
});

test('changing only the dark wallpaper preserves the light source and restores both', async () => {
    const f = fixture({overview: false});
    f.extension._createBlurredImage = async uri => `file:///cache/blur-wallpaper/blurred-${uri.split('/').pop()}`;
    f.settings.set('intensity', 120);
    await tick();
    f.bg.set('picture-uri-dark', 'file:///new-dark.jpg');
    await tick();
    assert.equal(f.bg.get_string('picture-uri'), 'file:///cache/blur-wallpaper/blurred-light.jpg');
    assert.equal(f.bg.get_string('picture-uri-dark'), 'file:///cache/blur-wallpaper/blurred-new-dark.jpg');
    f.extension.disable();
    assert.equal(f.bg.get_string('picture-uri'), 'file:///light.jpg');
    assert.equal(f.bg.get_string('picture-uri-dark'), 'file:///new-dark.jpg');
});

test('disable stops conversions, cancels waits and clears job ownership', async () => {
    const f = fixture({overview: false});
    const {Gio, GLib} = f.context;
    const files = new Set();
    const processes = [];
    Object.assign(GLib, {ChecksumType: {SHA256: 0},
        compute_checksum_for_string: () => 'key', mkdir_with_parents() {},
        get_num_processors: () => 1, uuid_string_random: () => 'unique'});
    Gio.File = {
        new_for_uri: () => ({get_path: () => '/light.jpg'}),
        new_for_path: path => ({query_exists: () => false,
            get_uri: () => `file://${path}`, delete: () => files.delete(path),
            move: () => assert.fail('Cancelled image must not enter cache')}),
    };
    Gio.Cancellable = class {
        cancel() { this.cancelled = true; this.onCancel?.(); }
        is_cancelled() { return !!this.cancelled; }
    };
    Gio.SubprocessFlags = {STDOUT_SILENCE: 1, STDERR_SILENCE: 2};
    Gio.Subprocess = {new(argv) {
        files.add(argv.at(-1));
        const proc = {
            force_exit() { this.stopped = true; },
            wait_async(cancellable, callback) {
                this.cancellable = cancellable;
                cancellable.onCancel = () => queueMicrotask(() => callback(this, {}));
            },
            wait_finish() { throw new Error('Cancelled'); },
        };
        processes.push(proc);
        return proc;
    }};
    delete f.extension._createBlurredImage;
    const pending = f.extension._blurImage('file:///light.jpg', 30);
    const oldJobs = f.extension._blurJobs;
    f.extension.disable();
    assert.equal(processes[0].stopped, true);
    assert.equal(processes[0].cancellable.is_cancelled(), true);
    assert.equal(oldJobs.size, 0);
    assert.equal(f.extension._blurJobs, null);
    assert.equal(f.extension._blurProcesses, null);
    assert.equal(await pending, null);
    assert.equal(files.size, 0);
});

test('old completion cannot remove an identical job in a new session', async () => {
    const f = fixture();
    f.extension.disable();
    f.extension.enable();
    assert.equal(f.jobs.length, 2);
    f.jobs[0].resolve();
    await tick();
    assert.equal(f.extension._blurJobs.size, 1);
    f.jobs[1].resolve();
    await tick();
    assert.equal(f.extension._blurJobs.size, 0);
    f.extension.disable();
});

test('overview is opt-in and does not create actors when off', () => {
    const f = fixture({overview: false});
    assert.equal(f.jobs.length, 0);
    assert.equal(f.group.children.length, 0);
    f.extension.disable();
});

test('overview uses original wallpaper and a lower blur than the desktop', async () => {
    const f = fixture({desktop: 120, intensity: 30});
    assert.deepEqual(f.jobs.map(j => [j.uri, j.sigma]),
        [['file:///light.jpg', 120], ['file:///light.jpg', 30]]);
    f.jobs[0].resolve();
    f.jobs[1].resolve();
    await tick();
    f.jobs[2].resolve(); // Dark desktop wallpaper.
    await tick();
    assert.equal(f.bg.get_string('picture-uri'), 'file:///cache/120-light.jpg');
    assert.equal(f.extension._overviewBackground.uri, 'file:///cache/30-light.jpg');
    f.settings.set('overview-intensity', 0);
    assert.equal(f.extension._overviewBackground.uri, 'file:///light.jpg');
    assert.equal(f.bg.get_string('picture-uri'), 'file:///cache/120-light.jpg');
    f.settings.set('intensity', 0);
    assert.equal(f.bg.get_string('picture-uri'), 'file:///light.jpg');
    assert.equal(f.extension._overviewBackground.uri, 'file:///light.jpg');
    f.extension.disable();
});

test('zero blur, theme changes, wallpaper changes and monitor geometry', () => {
    const f = fixture({intensity: 0});
    assert.equal(f.extension._overviewBackground.uri, 'file:///light.jpg');
    assert.equal(f.group.children.length, 2);
    const second = f.extension._overviewActors[1];
    assert.equal(JSON.stringify(second.position), '[-1280,0]');
    assert.equal(JSON.stringify(second.size), '[1280,1024]');
    f.iface.set('color-scheme', 'prefer-dark');
    assert.equal(f.extension._overviewBackground.uri, 'file:///dark.jpg');
    f.bg.set('picture-uri-dark', 'file:///new-dark.jpg');
    assert.equal(f.extension._overviewBackground.uri, 'file:///new-dark.jpg');
    f.layout.monitors = [f.layout.monitors[0]];
    f.layout.handlers.find(([signal]) => signal === 'monitors-changed')[1]();
    assert.equal(f.group.children.length, 1);
    f.settings.set('overview-wallpaper', false);
    assert.equal(f.group.children.length, 0);
    f.extension.disable();
    assert.equal(f.layout.handlers.length, 0);
    assert.equal(f.iface.handlers.length, 0);
});

test('rapid intensity changes coalesce and discard stale images', async () => {
    const f = fixture();
    f.settings.set('overview-intensity', 20);
    f.settings.set('overview-intensity', 10);
    assert.equal(f.jobs.length, 1);
    f.jobs[0].resolve();
    await tick();
    assert.equal(f.group.children.length, 0);
    assert.equal(f.jobs[1].sigma, 10);
    f.jobs[1].resolve();
    await tick();
    assert.equal(f.extension._overviewBackground.uri, 'file:///cache/10-light.jpg');
    f.extension.disable();
});

test('turning overview off or disabling prevents pending jobs from adding actors', async () => {
    for (const disable of [false, true]) {
        const f = fixture();
        if (disable) f.extension.disable();
        else f.settings.set('overview-wallpaper', false);
        f.jobs[0].resolve();
        await tick();
        assert.equal(f.group.children.length, 0);
        if (!disable) f.extension.disable();
    }
});

test('desktop and overview share identical in-flight blur jobs', async () => {
    const f = fixture({desktop: 30, intensity: 30});
    assert.equal(f.jobs.length, 1);
    f.jobs[0].resolve();
    await tick();
    f.jobs[1].resolve();
    await tick();
    assert.equal(f.bg.get_string('picture-uri'), f.extension._overviewBackground.uri);
    f.extension.disable();
});

test('jobs from a previous enable cannot overwrite a new session', async () => {
    const f = fixture({desktop: 120});
    f.extension.disable();
    f.settings.set('intensity', 90);
    f.settings.set('overview-intensity', 10);
    f.extension.enable();
    f.jobs[0].resolve();
    f.jobs[1].resolve();
    await tick();
    assert.equal(f.bg.get_string('picture-uri'), 'file:///light.jpg');
    assert.equal(f.group.children.length, 0);
    f.jobs.find(j => j.sigma === 90).resolve();
    f.jobs.find(j => j.sigma === 10).resolve();
    await tick();
    f.jobs.find(j => j.uri === 'file:///dark.jpg' && j.sigma === 90).resolve();
    await tick();
    assert.equal(f.bg.get_string('picture-uri'), 'file:///cache/90-light.jpg');
    assert.equal(f.extension._overviewBackground.uri, 'file:///cache/10-light.jpg');
    f.extension.disable();
});
