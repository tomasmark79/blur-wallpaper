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
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const BLURRED_PATH = `${GLib.get_tmp_dir()}/blur-wallpaper-blurred.jpg`;

export default class BlurWallpaperExtension extends Extension {
    constructor(metadata) {
        super(metadata);
    }

    // ── Pre-blurred image (static desktop blur) ───────────────────────────────
    // Blur is baked into a wallpaper file via ImageMagick and applied through
    // org.gnome.desktop.background – no GPU effect on the background group,
    // so workspace transitions never touch the blur at all.

    async _generateAndApplyBlurredWallpaper() {
        if (!this._isEnabled || this._applying || !this._bgSettings) return;
        this._applying = true;

        try {
            const pictureUri = this._sourceUri ?? this._bgSettings.get_string('picture-uri');
            if (!pictureUri) return;

            const picturePath = Gio.File.new_for_uri(pictureUri).get_path();
            if (!picturePath) return;

            const sigma = Math.round(this._blurRadius);
            if (sigma <= 0) {
                this._restoreWallpaper();
                return;
            }

            const proc = Gio.Subprocess.new(
                ['magick', picturePath, '-blur', `0x${sigma}`, BLURRED_PATH],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
            await new Promise((resolve, reject) => {
                proc.wait_async(null, (self, result) => {
                    try {
                        self.wait_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (!this._isEnabled || !this._bgSettings) return;
            if (!proc.get_successful()) return;

            const blurredUri = Gio.File.new_for_path(BLURRED_PATH).get_uri();

            // Preserve originals before first overwrite
            if (!this._originalUri) {
                this._originalUri = this._sourceUri ?? this._bgSettings.get_string('picture-uri');
                this._originalUriDark = this._sourceUriDark ?? this._bgSettings.get_string('picture-uri-dark');
            }

            this._settingBlur = true;
            this._bgSettings.set_string('picture-uri', blurredUri);
            this._bgSettings.set_string('picture-uri-dark', blurredUri);
            this._settingBlur = false;
        } catch (e) {
            console.error(`BlurWallpaper: convert failed – ${e.message}`);
        } finally {
            this._applying = false;
        }
    }

    _restoreWallpaper() {
        if (!this._originalUri) return;
        this._settingBlur = true;
        this._bgSettings.set_string('picture-uri', this._originalUri);
        this._bgSettings.set_string('picture-uri-dark', this._originalUriDark ?? this._originalUri);
        this._settingBlur = false;
        this._originalUri = null;
        this._originalUriDark = null;
        try { Gio.File.new_for_path(BLURRED_PATH).delete(null); } catch (_) { }
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    _initBlur() {
        this._blurRadius = this._settings?.get_int('intensity') ?? 0;
        this._applying = false;
        this._settingBlur = false;
        this._sourceUri = this._bgSettings.get_string('picture-uri');
        this._sourceUriDark = this._bgSettings.get_string('picture-uri-dark');
        this._originalUri = this._sourceUri;
        this._originalUriDark = this._sourceUriDark;

        this._bgSettings.connectObject('changed::picture-uri', () => {
            if (!this._settingBlur) {
                const nextSourceUri = this._bgSettings.get_string('picture-uri');
                const nextSourceUriDark = this._bgSettings.get_string('picture-uri-dark');
                if (nextSourceUri === this._sourceUri && nextSourceUriDark === this._sourceUriDark)
                    return;
                this._sourceUri = nextSourceUri;
                this._sourceUriDark = nextSourceUriDark;
                this._originalUri = this._sourceUri;
                this._originalUriDark = this._sourceUriDark;
                this._generateAndApplyBlurredWallpaper();
            }
        }, this);
        this._bgSettings.connectObject('changed::picture-uri-dark', () => {
            if (!this._settingBlur) {
                const nextSourceUri = this._bgSettings.get_string('picture-uri');
                const nextSourceUriDark = this._bgSettings.get_string('picture-uri-dark');
                if (nextSourceUri === this._sourceUri && nextSourceUriDark === this._sourceUriDark)
                    return;
                this._sourceUri = nextSourceUri;
                this._sourceUriDark = nextSourceUriDark;
                this._originalUri = this._sourceUri;
                this._originalUriDark = this._sourceUriDark;
                this._generateAndApplyBlurredWallpaper();
            }
        }, this);
        this._generateAndApplyBlurredWallpaper();
    }

    _refreshRadius() {
        const nextRadius = this._settings?.get_int('intensity') ?? 0;
        if (nextRadius === this._blurRadius) return;
        this._blurRadius = nextRadius;
        this._generateAndApplyBlurredWallpaper();
    }

    enable() {
        this._isEnabled = true;
        this._settings = this.getSettings();
        this._bgSettings = new Gio.Settings({ schema: 'org.gnome.desktop.background' });
        this._initBlur();

        this._settings?.connectObject('changed::intensity', () => this._refreshRadius(), this);
    }

    disable() {
        this._isEnabled = false;
        this._settings?.disconnectObject(this);
        this._bgSettings?.disconnectObject(this);
        this._settings = null;

        this._restoreWallpaper();
        this._bgSettings = null;
        this._blurRadius = null;
        this._sourceUri = null;
        this._sourceUriDark = null;
    }
}
