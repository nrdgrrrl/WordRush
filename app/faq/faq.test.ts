import FAQPage, { metadata } from './page';

describe('WordRush FAQ Page', () => {
  it('should export valid metadata with title and description', () => {
    expect(metadata.title).toContain('Frequently Asked Questions');
    expect(metadata.description).toBeDefined();
  });

  it('should render FAQPage React component function', () => {
    expect(FAQPage).toBeDefined();
    expect(typeof FAQPage).toBe('function');
  });
});
