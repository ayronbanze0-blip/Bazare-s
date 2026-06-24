const nodemailer = require('nodemailer');

const test = async () => {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: 'seu-email@gmail.com', // coloque o seu email
      pass: 'senha-de-16-caracteres' // coloque a App Password
    }
  });

  try {
    console.log("A tentar enviar...");
    await transporter.sendMail({
      from: '"Teste" <seu-email@gmail.com>',
      to: 'seu-email@gmail.com',
      subject: 'Teste de Conexão',
      text: 'Se recebeu isto, a conexão funciona!'
    });
    console.log("Sucesso!");
  } catch (err) {
    console.error("Erro:", err.message);
  }
};

test();
