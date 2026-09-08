/**
 * アプリ設定（Supabase 接続 / 出店要項リンク）
 * ここに入っているのは publishable（anon）key です。
 * ブラウザに公開される前提のキーですが、URL を知っている人は
 * 誰でもデータを編集できます。社外に共有しないでください。
 */
window.KC_CONFIG = {
  supabaseUrl: 'https://tfkzsbwhvhgxbnnfwtou.supabase.co',
  supabaseKey: 'sb_publishable_Ro1VwRK4o96IkyV6JC0q6w_vCjfFWYm',

  // ヘッダーの「出店要項」ボタンの遷移先（空にするとボタンを隠します）
  guidelinesUrl: 'https://docs.google.com/presentation/d/1CaH4001d3H6IKuTwfgSCg8hh9UDcHKPI/edit?usp=sharing&ouid=117005730905640987117&rtpof=true&sd=true',
};
