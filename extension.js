/* 
Copyright (C) 2026 Tomáš Mark

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'blur-wallpaper']);

export default class BlurWallpaperExtension extends Extension {
    constructor(metadata) {
        super(metadata);
    }

    // ── Pre-blurred image (static desktop blur) ───────────────────────────────
    // Blur is baked into a wallpaper file via ImageMagick and applied through
    // org.gnome.desktop.background – no GPU effect on the background group,
    // so workspace transitions never touch the blur at all.

    // Returns the URI of the blurred cached image, or null on failure.
    async _blurImage(pictureUri, sigma) {
        const jobs = this._blurJobs;
        if (!jobs) return null;
        const key = `${pictureUri}:${sigma}`;
        if (jobs.has(key))
            return jobs.get(key);

        const job = this._createBlurredImage(pictureUri, sigma);
        jobs.set(key, job);
        try {
            return await job;
        } finally {
            jobs.delete(key);
        }
    }

    async _createBlurredImage(pictureUri, sigma) {
        if (!pictureUri) return null;

        const picturePath = Gio.File.new_for_uri(pictureUri).get_path();
        if (!picturePath) return null;

        // ── Cache lookup ─────────────────────────────────────────────────
        const cacheKey = GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256, `${picturePath}:${sigma}`, -1
        );
        const cachedPath = GLib.build_filenamev([CACHE_DIR, `${cacheKey}.jpg`]);
        const cacheFile  = Gio.File.new_for_path(cachedPath);

        let cacheHit = false;
        if (cacheFile.query_exists(null)) {
            const ci = cacheFile.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            const si = Gio.File.new_for_path(picturePath)
                          .query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            cacheHit = ci.get_attribute_uint64('time::modified') >=
                       si.get_attribute_uint64('time::modified');
        }

        if (!cacheHit) {
            GLib.mkdir_with_parents(CACHE_DIR, 0o755);
            const threads = String(GLib.get_num_processors());
            // Publish only complete images; interrupted conversions must never
            // become cache hits, including across a quick disable/enable cycle.
            const temporaryPath = `${cachedPath}.${GLib.uuid_string_random()}.jpg`;
            const temporaryFile = Gio.File.new_for_path(temporaryPath);
            const proc = Gio.Subprocess.new(
                ['magick', '-limit', 'thread', threads, picturePath, '-blur', `0x${sigma}`, temporaryPath],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            const cancellable = new Gio.Cancellable();
            const processes = this._blurProcesses;
            const task = {proc, cancellable};
            processes.add(task);
            try {
                await new Promise((resolve, reject) => {
                    proc.wait_async(cancellable, (self, result) => {
                        try {
                            self.wait_finish(result);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                if (cancellable.is_cancelled() || !proc.get_successful()) return null;
                temporaryFile.move(cacheFile, Gio.FileCopyFlags.OVERWRITE, null, null);
            } catch (e) {
                if (!cancellable.is_cancelled()) throw e;
                return null;
            } finally {
                processes.delete(task);
                // On cancellation the child may still be exiting. Its unique
                // temporary path is never reused or considered a cached image.
                try {
                    temporaryFile.delete(null);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                        console.error(`BlurWallpaper: temporary image cleanup failed – ${e.message}`);
                }
            }
        }

        return cacheFile.get_uri();
    }

    _requestBlurUpdate() {
        this._generation = Symbol();

        if (this._applying) {
            this._pendingApply = true;
            return;
        }

        this._generateAndApplyBlurredWallpaper(this._generation);
    }

    _isCurrentBlurJob(generation, sourceUri, sourceUriDark, sigma) {
        return this._bgSettings &&
            generation === this._generation &&
            sourceUri === this._sourceUri &&
            sourceUriDark === this._sourceUriDark &&
            sigma === Math.round(this._blurRadius);
    }

    async _blurWallpaperVariant(uri, sigma) {
        if (!uri) return uri;
        try {
            return (await this._blurImage(uri, sigma)) ?? uri;
        } catch (e) {
            console.error(`BlurWallpaper: wallpaper variant failed – ${e.message}`);
            return uri;
        }
    }

    async _generateAndApplyBlurredWallpaper(generation) {
        if (this._applying || !this._bgSettings) return;
        this._applying = true;
        const bgSettings = this._bgSettings;

        try {
            const sourceUri     = this._sourceUri     ?? this._bgSettings.get_string('picture-uri');
            const sourceUriDark = this._sourceUriDark ?? this._bgSettings.get_string('picture-uri-dark');
            const sigma = Math.round(this._blurRadius);
            if (sigma <= 0) {
                this._restoreWallpaper();
                return;
            }

            // Blur light wallpaper
            const blurredUri = await this._blurWallpaperVariant(sourceUri, sigma);
            if (!this._isCurrentBlurJob(generation, sourceUri, sourceUriDark, sigma)) return;

            // Keep the two GNOME wallpaper settings independent, even when one
            // is empty or cannot be converted. Never substitute the other image.
            let blurredUriDark = blurredUri;
            if (sourceUriDark !== sourceUri) {
                blurredUriDark = await this._blurWallpaperVariant(sourceUriDark, sigma);
                if (!this._isCurrentBlurJob(generation, sourceUri, sourceUriDark, sigma)) return;
            }

            // Preserve originals before first overwrite
            if (this._originalUri == null) {
                this._originalUri     = sourceUri;
                this._originalUriDark = sourceUriDark;
            }

            this._settingBlur = true;
            this._bgSettings.set_string('picture-uri',      blurredUri);
            this._bgSettings.set_string('picture-uri-dark', blurredUriDark);
            this._settingBlur = false;
        } catch (e) {
            console.error(`BlurWallpaper: convert failed – ${e.message}`);
        } finally {
            if (this._bgSettings !== bgSettings)
                return;
            this._settingBlur = false;
            this._applying = false;
            if (this._pendingApply && this._bgSettings) {
                this._pendingApply = false;
                this._generateAndApplyBlurredWallpaper(this._generation);
            }
        }
    }

    _restoreWallpaper() {
        if (this._originalUri == null || !this._bgSettings) return;
        this._settingBlur = true;
        this._bgSettings.set_string('picture-uri', this._originalUri);
        this._bgSettings.set_string('picture-uri-dark', this._originalUriDark ?? this._originalUri);
        this._settingBlur = false;
        this._originalUri = null;
        this._originalUriDark = null;
        // Cached files are intentionally kept in CACHE_DIR for reuse.
    }

    _isManagedBlurUri(uri) {
        if (!uri || !this._cacheDirUri)
            return false;
        return uri.startsWith(`${this._cacheDirUri}/`);
    }

    _onBackgroundChanged() {
        if (this._settingBlur || !this._bgSettings)
            return;

        const currentUri = this._bgSettings.get_string('picture-uri');
        const currentUriDark = this._bgSettings.get_string('picture-uri-dark');

        const nextSourceUri = this._isManagedBlurUri(currentUri)
            ? this._sourceUri
            : currentUri;
        const nextSourceUriDark = this._isManagedBlurUri(currentUriDark)
            ? this._sourceUriDark
            : currentUriDark;

        if (nextSourceUri === this._sourceUri && nextSourceUriDark === this._sourceUriDark)
            return;

        this._sourceUri = nextSourceUri;
        this._sourceUriDark = nextSourceUriDark;
        this._originalUri = this._sourceUri;
        this._originalUriDark = this._sourceUriDark;

        this._requestBlurUpdate();
        this._requestOverviewUpdate();
    }

    // The overview gets its own Meta.Background, so its image never changes
    // the desktop background or the wallpaper shown inside workspace previews.
    _clearOverviewBackgrounds() {
        for (const actor of this._overviewActors ?? [])
            actor.destroy();
        this._overviewActors = [];
        this._overviewBackground = null;
    }

    _showOverviewWallpaper(uri) {
        const background = new Meta.Background({meta_display: global.display});
        const Color = Clutter.Color ?? Cogl.Color;
        const [, primary] = Color.from_string(this._bgSettings.get_string('primary-color'));
        const [, secondary] = Color.from_string(this._bgSettings.get_string('secondary-color'));
        const shading = this._bgSettings.get_enum('color-shading-type');
        if (shading === 0)
            background.set_color(primary);
        else
            background.set_gradient(shading, primary, secondary);
        background.set_file(uri ? Gio.File.new_for_uri(uri) : null,
            this._bgSettings.get_enum('picture-options'));

        this._clearOverviewBackgrounds();
        this._overviewBackground = background;
        for (const monitor of Main.layoutManager.monitors) {
            const actor = new Meta.BackgroundActor({
                meta_display: global.display,
                monitor: monitor.index,
                reactive: false,
            });
            actor.content.background = background;
            actor.set_position(monitor.x, monitor.y);
            actor.set_size(monitor.width, monitor.height);
            Main.layoutManager.overviewGroup.insert_child_at_index(actor, 0);
            this._overviewActors.push(actor);
        }
    }

    _requestOverviewUpdate() {
        const generation = Symbol();
        this._overviewGeneration = generation;
        if (!this._settings?.get_boolean('overview-wallpaper')) {
            this._clearOverviewBackgrounds();
            return;
        }

        if (this._overviewApplying) {
            this._overviewPending = true;
            return;
        }
        this._generateOverviewWallpaper(generation);
    }

    async _generateOverviewWallpaper(generation) {
        this._overviewApplying = true;
        const bgSettings = this._bgSettings;
        const dark = this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
        const sourceUri = (dark ? this._sourceUriDark : null) || this._sourceUri;
        const sigma = this._settings.get_int('overview-intensity');
        try {
            const uri = sigma > 0 && sourceUri
                ? await this._blurWallpaperVariant(sourceUri, sigma)
                : sourceUri;
            if (generation !== this._overviewGeneration || !this._bgSettings)
                return;
            if (sourceUri && !uri)
                return;
            this._showOverviewWallpaper(uri);
        } catch (e) {
            console.error(`BlurWallpaper: overview wallpaper failed – ${e.message}`);
        } finally {
            if (this._bgSettings !== bgSettings)
                return;
            this._overviewApplying = false;
            if (this._overviewPending) {
                this._overviewPending = false;
                this._requestOverviewUpdate();
            }
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    _initBlur() {
        this._blurRadius = this._settings?.get_int('intensity') ?? 0;
        this._applying = false;
        this._pendingApply = false;
        this._generation = null;
        this._settingBlur = false;
        this._cacheDirUri = Gio.File.new_for_path(CACHE_DIR).get_uri();
        this._sourceUri = this._bgSettings.get_string('picture-uri');
        this._sourceUriDark = this._bgSettings.get_string('picture-uri-dark');
        this._originalUri = this._sourceUri;
        this._originalUriDark = this._sourceUriDark;

        this._bgSettings.connectObject('changed::picture-uri', () => this._onBackgroundChanged(), this);
        this._bgSettings.connectObject('changed::picture-uri-dark', () => this._onBackgroundChanged(), this);
        this._requestBlurUpdate();
    }

    _refreshRadius() {
        const nextRadius = this._settings?.get_int('intensity') ?? 0;
        if (nextRadius === this._blurRadius) return;
        this._blurRadius = nextRadius;
        this._requestBlurUpdate();
    }

    enable() {
        this._blurJobs = new Map();
        this._blurProcesses = new Set();
        this._settings = this.getSettings();
        this._bgSettings = new Gio.Settings({ schema: 'org.gnome.desktop.background' });
        this._interfaceSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
        this._overviewApplying = false;
        this._overviewPending = false;
        this._initBlur();

        this._settings?.connectObject('changed::intensity', () => this._refreshRadius(), this);
        this._settings.connectObject(
            'changed::overview-wallpaper', () => this._requestOverviewUpdate(),
            'changed::overview-intensity', () => this._requestOverviewUpdate(), this);
        this._interfaceSettings.connectObject('changed::color-scheme',
            () => this._requestOverviewUpdate(), this);
        for (const key of ['picture-options', 'primary-color', 'secondary-color', 'color-shading-type'])
            this._bgSettings.connectObject(`changed::${key}`, () => this._requestOverviewUpdate(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._requestOverviewUpdate(), this);
        this._requestOverviewUpdate();
    }

    disable() {
        for (const {proc, cancellable} of this._blurProcesses ?? []) {
            proc.force_exit();
            cancellable.cancel();
        }
        this._blurProcesses?.clear();
        this._blurProcesses = null;
        this._blurJobs?.clear();
        this._blurJobs = null;
        this._settings?.disconnectObject(this);
        this._bgSettings?.disconnectObject(this);
        this._interfaceSettings?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._interfaceSettings = null;
        this._overviewGeneration = null;
        this._clearOverviewBackgrounds();
        this._settings = null;

        this._restoreWallpaper();
        this._bgSettings = null;
        this._blurRadius = null;
        this._sourceUri = null;
        this._sourceUriDark = null;
        this._cacheDirUri = null;
        this._generation = null;
        this._pendingApply = false;
    }
}
