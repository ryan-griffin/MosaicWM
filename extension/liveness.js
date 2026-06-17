// Copyright 2025 Cleo Menezes Jr.
// SPDX-License-Identifier: GPL-3.0-or-later

// get_compositor_private() can return a non-null actor that is already destroyed during
// signal delivery — calling get_frame_rect/move_resize_frame on it segfaults libmutter.
export function isWindowAlive(window) {
    if (!window) return false;
    const actor = window.get_compositor_private();
    return !!actor && !actor.is_destroyed();
}

// workspace.index() asserts in libmutter (meta_workspace_index: assertion 'ret >= 0'
// failed) if GNOME's dynamic-workspace system already removed this workspace from the
// manager, since the JS wrapper can outlive that removal. Check membership by reference
// instead of calling the native index lookup on a possibly-stale workspace.
export function isWorkspaceAlive(workspace, workspaceManager = global.workspace_manager) {
    if (!workspace) return false;
    for (let i = 0; i < workspaceManager.get_n_workspaces(); i++) {
        if (workspaceManager.get_workspace_by_index(i) === workspace) return true;
    }
    return false;
}
