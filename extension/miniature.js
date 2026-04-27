// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';

import * as Logger from './logger.js';
import * as WindowState from './windowState.js';
import {
    IS_MINIATURE,
    MINIATURE_SCALE,
    PRE_MINIATURE_SIZE,
    MINIATURE_TARGET_POS,
} from './windowState.js';

export const MiniatureManager = GObject.registerClass({
    GTypeName: 'MosaicMiniatureManager',
    Signals: {
        'miniature-created':  { param_types: [GObject.TYPE_OBJECT] },
        'miniature-restored': { param_types: [GObject.TYPE_OBJECT] },
    },
}, class MiniatureManager extends GObject.Object {
    _init() {
        super._init();
        this._miniatureWindows = new Set();
    }

    createMiniature(_window, _computedSlot) {
        return false;
    }

    restoreMiniature(_window, _newSlot) {
        return false;
    }

    destroyMiniature(_window) {}

    getMiniatureSize(_window) {
        return null;
    }
});

// Module-level helper — used by tiling.js without importing the full manager.
export function getMiniatureSize(window) {
    return global.MosaicExtension?.miniatureManager?.getMiniatureSize(window) ?? null;
}
