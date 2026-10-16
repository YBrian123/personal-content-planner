import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const {createClient}=vi.hoisted(()=>({createClient:vi.fn((..._args:unknown[])=>({auth:{}}))}));
vi.mock('@supabase/supabase-js',()=>({createClient}));
beforeEach(()=>{vi.resetModules();createClient.mockClear();vi.stubEnv('VITE_SUPABASE_URL','https://fixture.supabase.co');vi.stubEnv('VITE_SUPABASE_PROJECT_ID','fixture');vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY','sb_publishable_fixture');});
afterEach(()=>vi.unstubAllEnvs());
it.each([
  ['VITE_SUPABASE_URL',''],
  ['VITE_SUPABASE_URL','invalid-url'],
  ['VITE_SUPABASE_URL','https://different.supabase.co'],
  ['VITE_SUPABASE_URL','http://fixture.supabase.co'],
  ['VITE_SUPABASE_PUBLISHABLE_KEY','sb_secret_fixture'],
  ['VITE_SUPABASE_PUBLISHABLE_KEY','legacy-or-invalid-key'],
])('invalid connection %s=%s never creates a client or silently changes instance',async(key,value)=>{
  vi.stubEnv(key,value);const data=await import('../src/data');expect(data.configurationError).not.toBe('');expect(data.client).toBeNull();expect(createClient).not.toHaveBeenCalled();expect(await data.initialize()).toBeNull();await expect(data.api.export()).rejects.toThrow(data.configurationError);
});
it('matching public configuration creates only the requested instance',async()=>{
  const data=await import('../src/data');expect(data.configurationError).toBe('');expect(data.instance).toBe('fixture');expect(createClient).toHaveBeenCalledOnce();expect(createClient.mock.calls[0].slice(0,2)).toEqual(['https://fixture.supabase.co','sb_publishable_fixture']);
});
