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
    MINIATURE_EXT_LEFT,
    MINIATURE_EXT_TOP,
} from './windowState.js';

/**
 * Apply miniature visual state to a window actor.
 *
 * On GNOME Wayland, move_frame is ASYNC and Mutter may REJECT the target
 * position if the frame rect (original, unscaled size) would extend beyond
 * the monitor. So we cannot rely on move_frame to place the actor.
 *
 * Instead, we compute the translation from the actor's CURRENT position
 * to place the frame visual at the desired target:
 *
 *   frame_visual_x = actorX + tx + extLeft * scale = targetX
 *   tx = targetX - actorX - extLeft * scale
 *
 * This works regardless of where Mutter actually placed the actor.
 */
export function applyMiniatureActorState(actor, scale, extLeft, extTop, targetX, targetY) {
    actor.set_pivot_point(0, 0);
    actor.remove_all_transitions();
    actor.set_scale(scale, scale);
    const [ax, ay] = actor.get_position();
    const tx = targetX - ax - extLeft * scale;
    const ty = targetY - ay - extTop * scale;
    actor.set_translation(tx, ty, 0);
}

export const MiniatureManager = GObject.registerClass({
    GTypeName: 'MosaicMiniatureManager',
    Signals: {
        'miniature-created': { param_types: [GObject.TYPE_OBJECT] },
        'miniature-restored': { param_types: [GObject.TYPE_OBJECT] },
    },
}, class MiniatureManager extends GObject.Object {
    _init() {
        super._init();
        this._miniatureWindows = new Set();
    }

    createMiniature(window, computedSlot) {
        const windowActor = window.get_compositor_private();
        if (!windowActor) return false;

        const preSize = window.get_frame_rect();
        const scale = 256 / Math.max(preSize.width, preSize.height);

        const targetX = computedSlot.x;
        const targetY = computedSlot.y;

        // Compute shadow extents BEFORE any move (frame and actor are in sync)
        const [actorBefore_x, actorBefore_y] = windowActor.get_position();
        const extLeft = preSize.x - actorBefore_x;
        const extTop = preSize.y - actorBefore_y;

        Logger.log(`[MINIATURE] createMiniature ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): preFrame=(${preSize.x},${preSize.y} ${preSize.width}x${preSize.height}) actorBefore=(${actorBefore_x},${actorBefore_y}) target=(${targetX},${targetY}) scale=${scale.toFixed(4)} extLeft=${extLeft} extTop=${extTop}`);

        // Do NOT use move_frame — Mutter may reject the position because the
        // frame rect (original size) extends beyond the monitor.
        // Instead, rely purely on actor transforms to position the miniature.

        // Apply scale + translation from CURRENT actor position to target
        applyMiniatureActorState(windowActor, scale, extLeft, extTop, targetX, targetY);

        // Verify actual visual position after Mutter settles
        const _winId = window.get_id();
        const _verifyTarget = { x: targetX, y: targetY };
        const _verifyScale = scale;
        const _verifyExtL = extLeft;
        const _verifyExtT = extTop;
        const _verifyActor = windowActor;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            const frame = window.get_frame_rect();
            const [ax, ay] = _verifyActor.get_position();
            const tx = _verifyActor.get_translation();
            const visualLeft = ax + tx[0] + _verifyExtL * _verifyScale;
            const visualTop = ay + tx[1] + _verifyExtT * _verifyScale;
            Logger.log(`[MINIATURE] VERIFY ${_winId}: frame=(${frame.x},${frame.y}) actor=(${ax},${ay}) translation=(${tx[0]?.toFixed(2)},${tx[1]?.toFixed(2)}) visualFrame=(${visualLeft.toFixed(1)},${visualTop.toFixed(1)}) expected=(${_verifyTarget.x},${_verifyTarget.y}) diff=(${(visualLeft - _verifyTarget.x).toFixed(1)},${(visualTop - _verifyTarget.y).toFixed(1)})`);
            return GLib.SOURCE_REMOVE;
        });

        // Store state including extents
        WindowState.set(window, IS_MINIATURE, true);
        WindowState.set(window, MINIATURE_SCALE, scale);
        WindowState.set(window, PRE_MINIATURE_SIZE, { width: preSize.width, height: preSize.height });
        WindowState.set(window, MINIATURE_TARGET_POS, { x: targetX, y: targetY });
        WindowState.set(window, MINIATURE_EXT_LEFT, extLeft);
        WindowState.set(window, MINIATURE_EXT_TOP, extTop);

        Logger.log(`[MINIATURE] createMiniature ${window.get_id()}: miniSize=${Math.round(preSize.width * scale)}x${Math.round(preSize.height * scale)}`);

        // Prevent focus handler from immediately restoring (expires in 500 ms)
        WindowState.set(window, 'justMiniaturized', true);
        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            WindowState.remove(window, 'justMiniaturized');
            return GLib.SOURCE_REMOVE;
        });
        WindowState.set(window, 'miniatureJustMiniaturizedTimeoutId', timeoutId);

        // Re-apply scale+translation whenever actor is re-shown (workspace return safety net)
        const showSignalId = windowActor.connect('show', () => {
            const savedScale = WindowState.get(window, MINIATURE_SCALE);
            const savedExtLeft = WindowState.get(window, MINIATURE_EXT_LEFT) ?? 0;
            const savedExtTop = WindowState.get(window, MINIATURE_EXT_TOP) ?? 0;
            const savedTarget = WindowState.get(window, MINIATURE_TARGET_POS);
            if (!savedScale) return;
            const [ax, ay] = windowActor.get_position();
            Logger.log(`[MINIATURE] show signal ${window.get_id()}: actor=(${ax},${ay}) target=${savedTarget ? `(${savedTarget.x},${savedTarget.y})` : 'none'} scale=${savedScale.toFixed(4)}`);
            if (savedTarget) {
                // Apply immediately
                applyMiniatureActorState(windowActor, savedScale, savedExtLeft, savedExtTop, savedTarget.x, savedTarget.y);
                // Re-apply after Mutter finishes processing (idle callback)
                GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                    if (!WindowState.get(window, IS_MINIATURE)) return GLib.SOURCE_REMOVE;
                    const [ax2, ay2] = windowActor.get_position();
                    Logger.log(`[MINIATURE] show idle ${window.get_id()}: actor=(${ax2},${ay2}) re-applying`);
                    applyMiniatureActorState(windowActor, savedScale, savedExtLeft, savedExtTop, savedTarget.x, savedTarget.y);
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                Logger.log(`[MINIATURE] show signal: no target pos for ${window.get_id()}, skipping re-apply`);
            }
        });
        WindowState.set(window, 'miniatureShowSignalId', showSignalId);

        this._miniatureWindows.add(window.get_id());
        this.emit('miniature-created', window);

        Logger.log(`[MINIATURE] Created miniature for ${window.get_id()}, scale=${scale.toFixed(4)}`);
        return true;
    }

    restoreMiniature(window, _newSlot) {
        const windowActor = window.get_compositor_private();

        const frame = window.get_frame_rect();
        const [ax, ay] = windowActor ? windowActor.get_position() : [0, 0];
        const sc = WindowState.get(window, MINIATURE_SCALE) ?? 1;
        Logger.log(`[MINIATURE] restoreMiniature START ${window.get_id()} (${window.get_wm_class?.() ?? '?'}): frame=(${frame.x},${frame.y} ${frame.width}x${frame.height}) actor=(${ax},${ay}) scale=${sc.toFixed(4)}`);

        WindowState.remove(window, IS_MINIATURE);
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);
        WindowState.remove(window, MINIATURE_EXT_LEFT);
        WindowState.remove(window, MINIATURE_EXT_TOP);

        if (windowActor) {
            windowActor.remove_all_transitions();
            windowActor.set_scale(1.0, 1.0);
            windowActor.set_translation(0, 0, 0);

            const showSignalId = WindowState.get(window, 'miniatureShowSignalId');
            if (showSignalId) windowActor.disconnect(showSignalId);
        }
        WindowState.remove(window, 'miniatureShowSignalId');

        const timeoutId = WindowState.get(window, 'miniatureJustMiniaturizedTimeoutId');
        if (timeoutId) GLib.source_remove(timeoutId);
        WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
        WindowState.remove(window, 'justMiniaturized');

        this._miniatureWindows.delete(window.get_id());
        this.emit('miniature-restored', window);

        Logger.log(`[MINIATURE] Restored miniature ${window.get_id()}`);
        return true;
    }

    destroyMiniature(window) {
        const windowActor = window.get_compositor_private();

        WindowState.remove(window, IS_MINIATURE);
        WindowState.remove(window, MINIATURE_SCALE);
        WindowState.remove(window, PRE_MINIATURE_SIZE);
        WindowState.remove(window, MINIATURE_TARGET_POS);
        WindowState.remove(window, MINIATURE_EXT_LEFT);
        WindowState.remove(window, MINIATURE_EXT_TOP);

        if (windowActor) {
            const showSignalId = WindowState.get(window, 'miniatureShowSignalId');
            if (showSignalId) windowActor.disconnect(showSignalId);
        }
        WindowState.remove(window, 'miniatureShowSignalId');

        const timeoutId = WindowState.get(window, 'miniatureJustMiniaturizedTimeoutId');
        if (timeoutId) GLib.source_remove(timeoutId);
        WindowState.remove(window, 'miniatureJustMiniaturizedTimeoutId');
        WindowState.remove(window, 'justMiniaturized');

        this._miniatureWindows.delete(window.get_id());
        Logger.log(`[MINIATURE] Destroyed miniature ${window.get_id()} (window closed)`);
    }

    getMiniatureSize(window) {
        if (!WindowState.get(window, IS_MINIATURE)) return null;
        const preSize = WindowState.get(window, PRE_MINIATURE_SIZE);
        const scale = WindowState.get(window, MINIATURE_SCALE);
        if (!preSize || !scale) return null;
        return {
            width: Math.round(preSize.width * scale),
            height: Math.round(preSize.height * scale),
        };
    }
});

// Module-level helper — used by tiling.js without importing the full manager.
export function getMiniatureSize(window) {
    return global.MosaicExtension?.miniatureManager?.getMiniatureSize(window) ?? null;
}
