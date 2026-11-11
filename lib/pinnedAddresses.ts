// Sample addresses the app offers as "Try these". Their reports are cached for 30
// days instead of 24 hours, and scripts/warm-cache.ts pre-loads them.
//
// This list must match src/sampleAddresses.ts in the mobile repo. They live in two
// repos on purpose (the app can't import backend code); change both together.
//
// No imports: scripts/warm-cache.ts loads this file under plain Node.
export const PINNED_ADDRESSES: readonly string[] = [
  "3901 Prentice Ln, Austin, TX 78746",
  "3712 Meredith St, Austin, TX 78703",
];
