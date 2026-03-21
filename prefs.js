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

import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';


export default class BlurWallpaperPreferences extends ExtensionPreferences {
    _getBlurRadiusBounds(settings) {
        const fallback = { min: 0, max: 300, def: 120 };

        try {
            const range = settings.settings_schema.get_key('intensity').get_range().deepUnpack();
            const defaultValue = settings.get_default_value('intensity').deepUnpack();

            if (!Array.isArray(range) || range.length < 2)
                return fallback;

            const unpacked = Array.isArray(range[1])
                ? range[1]
                : range[1]?.deepUnpack?.() ?? [];

            if (!Array.isArray(unpacked) || unpacked.length < 2)
                return fallback;

            return {
                min: Number(unpacked[0]),
                max: Number(unpacked[1]),
                def: Number(defaultValue),
            };
        } catch (_) {
            return fallback;
        }
    }

    fillPreferencesWindow(window) {
        window._settings = this.getSettings();
        const bounds = this._getBlurRadiusBounds(window._settings);

        const page = new Adw.PreferencesPage({
            title: 'Blur Wallpaper extension',
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup();
        page.add(group);

        const adjustmentRadius = new Gtk.Adjustment({
            lower: bounds.min,
            upper: bounds.max,
            value: bounds.def,
            step_increment: 1,
            page_increment: 5,
        });

        const blurRadius = new Adw.SpinRow({
            title: 'Intensity (px)',
            subtitle: `${bounds.min} = no blur, ${bounds.max} = very strong blur.`,
            adjustment: adjustmentRadius,
        });
        group.add(blurRadius);
        window._settings.bind('intensity', blurRadius, 'value', Gio.SettingsBindFlags.DEFAULT);

    }
}
