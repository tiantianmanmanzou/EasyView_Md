import * as React from 'react';
import type { PreviewAssetConfig } from './types';

const PreviewAssetsContext = React.createContext<PreviewAssetConfig | null>(null);

export function PreviewAssetsProvider({
  assets,
  children,
}: {
  assets: PreviewAssetConfig;
  children?: React.ReactNode;
}): React.ReactElement {
  return React.createElement(PreviewAssetsContext.Provider, { value: assets }, children);
}

export function usePreviewAssets(): PreviewAssetConfig {
  const assets = React.useContext(PreviewAssetsContext);
  if (!assets) throw new Error('PreviewAssetsProvider is required');
  return assets;
}
