/*
Copyright 2024 New Vector Ltd.
Copyright 2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { ActionPayload } from "../payloads";
import { Action } from "../actions";
import { SettingLevel } from "../../settings/SettingLevel";
import { SettingValueType } from "../../settings/Settings";

export interface SettingUpdatedPayload extends ActionPayload {
    action: Action.SettingUpdated;

    settingName: string;
    roomId: string | null;
    level: SettingLevel;
    newValueAtLevel: SettingLevel;
    newValue: SettingValueType;
}
