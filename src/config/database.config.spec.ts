import databaseConfig from './database.config';

describe('database schema management', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it.each(['development', 'test', 'production'])(
    'prevents startup schema changes in %s even when requested',
    (environment) => {
      process.env.NODE_ENV = environment;
      process.env.DB_SYNCHRONIZE = 'true';
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});

      expect(databaseConfig().synchronize).toBe(false);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('npm run migration:run'),
      );
    },
  );
});
