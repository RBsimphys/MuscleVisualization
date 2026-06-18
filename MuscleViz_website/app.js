const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));

let latestValue = 0;

app.post('/adc', (req, res) => {
    latestValue = req.body.value;
    console.log('ADC:', latestValue);
    res.send('ok');
});

app.get('/adc', (req, res) => {
    res.json({ value: latestValue });
});

app.listen(3000, () => console.log('listening on port 3000'));