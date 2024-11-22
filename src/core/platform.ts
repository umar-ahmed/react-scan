export const hasSkia = (): boolean => {
  if (typeof window !== 'undefined' && !('ReactNative' in window)) {
    return false;
  }

  try {
    require('@shopify/react-native-skia');
    return true;
  } catch (e) {
    return false;
  }
};

export const requireSkia = () => {
  if (!hasSkia()) {
    throw new Error(
      '[your-package]: @shopify/react-native-skia is required for this component.\n' +
        'Please install it with: npm install @shopify/react-native-skia\n' +
        'Or: yarn add @shopify/react-native-skia',
    );
  }
};
