import { describe, expect, it } from 'vitest';
import { buttonVariants } from './Button';

describe('buttonVariants', () => {
  it('applies defaults and supplied variants', () => {
    expect(buttonVariants()).toContain('bg-primary');
    expect(buttonVariants()).toContain('h-10');
    expect(buttonVariants({ variant: 'ghost', size: 'icon', className: 'extra' })).toContain('hover:bg-accent');
    expect(buttonVariants({ variant: 'ghost', size: 'icon', className: 'extra' })).toContain('h-9 w-9');
    expect(buttonVariants({ variant: 'ghost', size: 'icon', className: 'extra' })).toContain('extra');
    expect(buttonVariants({ variant: null, size: null })).not.toContain('bg-primary');
    expect(buttonVariants({ variant: null, size: null })).not.toContain('h-10');
  });
});
