import type { Locator } from '@playwright/test';

/** 搬送などのカードで操作を押す。「次にすること」に出ていなければ「ほかの操作」を開いてから押す */
export async function clickAction(card: Locator, name: string) {
  const button = () => card.getByRole('button', { name: new RegExp(`^${name}`) }).filter({ visible: true });
  if ((await button().count()) === 0) await card.locator('summary', { hasText: 'ほかの操作' }).click();
  await button().first().click();
}
