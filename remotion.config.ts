// Copyright (c) 2026 Enrique Rocha (@soyenriquerocha)
// SPDX-License-Identifier: MIT
// id: er-2f298797
import {Config} from '@remotion/cli/config';

// Remotion solo lee este archivo de variables: no contiene secretos.
Config.setDotEnvLocation('.env.remotion');
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setOverwriteOutput(true);
Config.setPublicDir('public');
