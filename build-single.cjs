const fs = require('fs');
const dir = '/home/user/Co';
let html = fs.readFileSync(dir + '/index.html', 'utf8');
const css = fs.readFileSync(dir + '/styles.css', 'utf8');
const js = fs.readFileSync(dir + '/app.js', 'utf8');

// Replace external <link rel="stylesheet" href="styles.css"> with inline <style>
html = html.replace(/<link rel="stylesheet" href="styles\.css"\s*\/>/, `<style>\n${css}\n</style>`);
// Replace <script src="app.js"></script> with inline script
html = html.replace(/<script src="app\.js"><\/script>/, `<script>\n${js}\n</script>`);

fs.writeFileSync(dir + '/moms-app.html', html);
console.log('Built moms-app.html:', (fs.statSync(dir + '/moms-app.html').size/1024).toFixed(1) + ' KB');
// sanity: ensure no remaining external refs to local files
console.log('styles.css ref left:', /href="styles\.css"/.test(html));
console.log('app.js ref left:', /src="app\.js"/.test(html));
