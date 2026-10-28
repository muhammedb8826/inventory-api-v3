import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => {
  const accessSecret = process.env.JWT_AT_SECRET ?? 'change-me';
  const refreshSecret = process.env.JWT_RT_SECRET ?? 'change-me-rt';
  if (
    process.env.NODE_ENV === 'production' &&
    (accessSecret.length < 32 ||
      refreshSecret.length < 32 ||
      accessSecret === refreshSecret)
  ) {
    throw new Error(
      'Production requires distinct JWT_AT_SECRET and JWT_RT_SECRET of at least 32 characters',
    );
  }
  return {
    accessSecret,
    refreshSecret,
    accessExpiresIn: process.env.JWT_AT_EXPIRES_IN ?? '15m',
    refreshExpiresIn: process.env.JWT_RT_EXPIRES_IN ?? '7d',
  };
});
