// Junta index.html + css + js num unico arquivo (dist/triagem-de-avarias.html),
// util para enviar por e-mail, abrir direto no celular ou hospedar em qualquer lugar.
const fs = require('fs');
const path = require('path');

function buildSingleFile() {
  const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
  let html = read('index.html');
  html = html.replace('<link rel="stylesheet" href="css/style.css">', () => '<style>\n' + read('css/style.css') + '</style>');
  html = html.replace('<script src="js/pipeline.js"></script>', () => '<script>\n' + read('js/pipeline.js') + '</script>');
  html = html.replace('<script src="js/app.js"></script>', () => '<script>\n' + read('js/app.js') + '</script>');
  return html;
}

module.exports = { buildSingleFile };

if (require.main === module) {
  const out = path.join(__dirname, 'dist');
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, 'triagem-de-avarias.html');
  fs.writeFileSync(file, buildSingleFile());
  console.log('Gerado:', file, '(' + Math.round(fs.statSync(file).size / 1024) + ' kB)');
}
