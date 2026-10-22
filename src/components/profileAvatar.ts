/**
 * One avatar-shape rule for Kivo Mobile.
 * Only a server-confirmed active Blue Star profile uses rounded-square corners.
 * Unknown, expired, failed, or unverified states stay circular.
 */
export function profileAvatarBorderRadius(size: number, verified: boolean): number {
  return verified ? 6 : size / 2;
}
