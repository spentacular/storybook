import { navigate as navigateRouter, NavigateOptions } from '@reach/router';
import { once } from '@storybook/client-logger';
import {
  NAVIGATE_URL,
  STORY_ARGS_UPDATED,
  SET_CURRENT_STORY,
  GLOBALS_UPDATED,
} from '@storybook/core-events';
import { queryFromLocation, navigate as queryNavigate, buildArgsParam } from '@storybook/router';
import { toId, sanitize } from '@storybook/csf';
import deepEqual from 'fast-deep-equal';
import global from 'global';
import dedent from 'ts-dedent';

import { ModuleArgs, ModuleFn } from '../index';
import { Layout, UI } from './layout';
import { isStory } from '../lib/stories';

const { window: globalWindow } = global;

export interface SubState {
  customQueryParams: QueryParams;
}

// Initialize the state based on the URL.
// NOTE:
//   Although we don't change the URL when you change the state, we do support setting initial state
//   via the following URL parameters:
//     - full: 0/1 -- show fullscreen
//     - panel: bottom/right/0 -- set addons panel position (or hide)
//     - nav: 0/1 -- show or hide the story list
//
//   We also support legacy URLs from storybook <5
let prevParams: ReturnType<typeof queryFromLocation>;
const initialUrlSupport = ({
  state: { location, path, viewMode, storyId: storyIdFromUrl },
}: ModuleArgs) => {
  const layout: Partial<Layout> = {};
  const ui: Partial<UI> = {};
  const query = queryFromLocation(location);
  let selectedPanel;

  const {
    full,
    panel,
    nav,
    shortcuts,
    addonPanel,
    addons, // deprecated
    panelRight, // deprecated
    stories, // deprecated
    selectedKind, // deprecated
    selectedStory, // deprecated
    path: queryPath,
    ...otherParams // the rest gets passed to the iframe
  } = query;

  if (full === 'true' || full === '1') {
    layout.isFullscreen = true;
  }
  if (panel) {
    if (['right', 'bottom'].includes(panel)) {
      layout.panelPosition = panel;
    } else if (panel === 'false' || panel === '0') {
      layout.showPanel = false;
    }
  }
  if (nav === 'false' || nav === '0') {
    layout.showNav = false;
  }
  if (shortcuts === 'false' || shortcuts === '0') {
    ui.enableShortcuts = false;
  }
  if (addonPanel) {
    selectedPanel = addonPanel;
  }

  // @deprecated Superceded by `panel=false`, to be removed in 7.0
  if (addons === '0') {
    once.warn(dedent`
      The 'addons' query param is deprecated and will be removed in Storybook 7.0. Use 'panel=false' instead.

      More info: https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#deprecated-layout-url-params
    `);
    layout.showPanel = false;
  }
  // @deprecated Superceded by `panel=right`, to be removed in 7.0
  if (panelRight === '1') {
    once.warn(dedent`
      The 'panelRight' query param is deprecated and will be removed in Storybook 7.0. Use 'panel=right' instead.

      More info: https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#deprecated-layout-url-params
    `);
    layout.panelPosition = 'right';
  }
  // @deprecated Superceded by `nav=false`, to be removed in 7.0
  if (stories === '0') {
    once.warn(dedent`
      The 'stories' query param is deprecated and will be removed in Storybook 7.0. Use 'nav=false' instead.

      More info: https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#deprecated-layout-url-params
    `);
    layout.showNav = false;
  }

  // @deprecated To be removed in 7.0
  // If the user hasn't set the storyId on the URL, we support legacy URLs (selectedKind/selectedStory)
  // NOTE: this "storyId" can just be a prefix of a storyId, really it is a storyIdSpecifier.
  let storyId = storyIdFromUrl;
  if (!storyId && selectedKind) {
    once.warn(dedent`
      The 'selectedKind' and 'selectedStory' query params are deprecated and will be removed in Storybook 7.0. Use 'path' instead.

      More info: https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#deprecated-layout-url-params
    `);
    storyId = selectedStory ? toId(selectedKind, selectedStory) : sanitize(selectedKind);
  }

  // Avoid returning a new object each time if no params actually changed.
  const customQueryParams = deepEqual(prevParams, otherParams) ? prevParams : otherParams;
  prevParams = customQueryParams;

  return { viewMode, layout, ui, selectedPanel, location, path, customQueryParams, storyId };
};

export interface QueryParams {
  [key: string]: string | null;
}

export interface SubAPI {
  navigateUrl: (url: string, options: NavigateOptions<{}>) => void;
  getQueryParam: (key: string) => string | undefined;
  getUrlState: () => {
    queryParams: QueryParams;
    path: string;
    viewMode?: string;
    storyId?: string;
    url: string;
  };
  setQueryParams: (input: QueryParams) => void;
}

export const init: ModuleFn = ({ store, navigate, state, provider, fullAPI, ...rest }) => {
  const api: SubAPI = {
    getQueryParam(key) {
      const { customQueryParams } = store.getState();
      return customQueryParams ? customQueryParams[key] : undefined;
    },
    getUrlState() {
      const { path, customQueryParams, storyId, url, viewMode } = store.getState();
      return { path, queryParams: customQueryParams, storyId, url, viewMode };
    },
    setQueryParams(input) {
      const { customQueryParams } = store.getState();
      const queryParams: QueryParams = {};
      const update = {
        ...customQueryParams,
        ...Object.entries(input).reduce((acc, [key, value]) => {
          if (value !== null) {
            acc[key] = value;
          }
          return acc;
        }, queryParams),
      };
      const equal = deepEqual(customQueryParams, update);
      if (!equal) store.setState({ customQueryParams: update });
    },
    navigateUrl(url: string, options: NavigateOptions<{}>) {
      navigateRouter(url, options);
    },
  };

  const initModule = () => {
    // Sets `args` parameter in URL, omitting any args that have their initial value or cannot be unserialized safely.
    const updateArgsParam = () => {
      const { path, viewMode } = fullAPI.getUrlState();
      if (viewMode !== 'story') return;

      const currentStory = fullAPI.getCurrentStoryData();
      if (!isStory(currentStory)) return;

      const { args, initialArgs } = currentStory;
      const argsString = buildArgsParam(initialArgs, args);
      const argsParam = argsString.length ? `&args=${argsString}` : '';
      queryNavigate(`${path}${argsParam}`, { replace: true });
      api.setQueryParams({ args: argsString });
    };

    fullAPI.on(SET_CURRENT_STORY, () => updateArgsParam());

    let handleOrId: any;
    fullAPI.on(STORY_ARGS_UPDATED, () => {
      if ('requestIdleCallback' in globalWindow) {
        if (handleOrId) globalWindow.cancelIdleCallback(handleOrId);
        handleOrId = globalWindow.requestIdleCallback(updateArgsParam, { timeout: 1000 });
      } else {
        if (handleOrId) clearTimeout(handleOrId);
        setTimeout(updateArgsParam, 100);
      }
    });

    fullAPI.on(GLOBALS_UPDATED, ({ globals, initialGlobals }) => {
      const { path } = fullAPI.getUrlState();
      const argsString = buildArgsParam(initialGlobals, globals);
      const globalsParam = argsString.length ? `&globals=${argsString}` : '';
      queryNavigate(`${path}${globalsParam}`, { replace: true });
      api.setQueryParams({ globals: argsString });
    });

    fullAPI.on(NAVIGATE_URL, (url: string, options: { [k: string]: any }) => {
      fullAPI.navigateUrl(url, options);
    });

    if (fullAPI.showReleaseNotesOnLaunch()) {
      navigate('/settings/release-notes');
    }
  };

  return {
    api,
    state: initialUrlSupport({ store, navigate, state, provider, fullAPI, ...rest }),
    init: initModule,
  };
};
