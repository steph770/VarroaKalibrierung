// Verbindung zur gemeinsamen Supabase-Datenbank.
// Hier eintragen, dann müssen Mitwirkende nur noch Einladungscode und Kürzel eingeben.
// Beides steht im Supabase-Projekt unter "Project Settings → API".
// Der "anon public"-Schlüssel darf öffentlich sein; geschützt sind die Daten über den Einladungscode.
export const CONFIG = {
  supabaseUrl: '',      // z. B. 'https://grrcwjkpdodibqinzphw.supabase.co/rest/v1/'
  supabaseAnonKey: '',  // z. B. 'sb_publishable_o9W3veBEmz5Dg6JXgy5RSA_WO7Hg8C9'
};
