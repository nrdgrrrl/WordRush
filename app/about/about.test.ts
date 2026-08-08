import AboutPage, { metadata } from './page';

describe('WordRush About Page', () => {
  it('should export valid metadata with title and description', () => {
    expect(metadata.title).toContain('About WordRush');
    expect(metadata.description).toBeDefined();
  });

  it('should render AboutPage React component function', () => {
    expect(AboutPage).toBeDefined();
    expect(typeof AboutPage).toBe('function');
  });
});
