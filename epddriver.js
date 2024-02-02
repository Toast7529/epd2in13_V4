const rpio = require('rpio');
const spi = require('spi-device');
const { Image } = require('image-js');

// Resolution
const DEVICE_WIDTH = 122;
const DEVICE_HEIGHT = 250;

let RST_PIN = 11;
let DC_PIN = 22;
let CS_PIN = 24;
let BUSY_PIN = 18;

class epd2in13 {
	constructor(config = {}) {
		this.gpio = rpio;
		this.spi = false;

		if (config.RST_PIN) RST_PIN = config.RST_PIN;
		if (config.RST_PIN) DC_PIN = config.DC_PIN;
		if (config.RST_PIN) CS_PIN = config.CS_PIN;
		if (config.RST_PIN) BUSY_PIN = config.BUSY_PIN;

		this.width = DEVICE_WIDTH;
		this.height = DEVICE_HEIGHT;
	}

	async reset() {
		this.gpio.write(RST_PIN, 1);
		this.gpio.msleep(20);
		this.gpio.write(RST_PIN, 0);
		this.gpio.msleep(2);
		this.gpio.write(RST_PIN, 1);
		this.gpio.msleep(20);
	}

	send_buffer(sendBuffer) {
		return new Promise((resolve, reject) => {
			this.spi.transfer(
				[{
                    sendBuffer,
                    byteLength: sendBuffer.byteLength,
                    speedHz: 2000000, // 2Mhz first
				}],
				(err, message) => {
					if (err) reject(err);
					resolve();
				}
			);
		});
	}

	async send_command(data) {
		this.gpio.write(DC_PIN, 0);
		this.gpio.write(CS_PIN, 0);
		await this.send_buffer(Buffer.isBuffer(data) ? data : Buffer.from([data]));
		this.gpio.write(CS_PIN, 1);
	}

	async send_data(data) {
		this.gpio.write(DC_PIN, 1);
		this.gpio.write(CS_PIN, 0);
		await this.send_buffer(Buffer.isBuffer(data) ? data : Buffer.from([data]));
		this.gpio.write(CS_PIN, 1);
	}

	async readBusy() {
		console.log('e-Paper busy');
		while (this.gpio.read(BUSY_PIN) == 1) // 0:idle, 1: busy
			this.gpio.msleep(10);
		console.log('e-Paper busy release');
	}

	async TurnOnDisplay(){
		await this.send_command(0x22) // Display Update Control
        await this.send_data(0xf7)
        await this.send_command(0x20) // Activate Display Update Sequence
        await this.readBusy()
	}

	async TurnOnDisplayFast(){
		await this.send_command(0x22) // Display Update Control
		await this.send_data(0xC7)
		await this.send_command(0x20) // Activate Display Update Sequence
		await this.readBusy()
	}	

	async TurnOnDisplayPart(){
		await this.send_command(0x22) // Display Update Control
		await this.send_data(0xff)
		await this.send_command(0x20) // Activate Display Update Sequence
		await this.readBusy()
	}

	async SetWindow(x_start, y_start, x_end, y_end){
		await this.send_command(0x44) // SET_RAM_X_ADDRESS_START_END_POSITION
		 // x point must be the multiple of 8 or the last 3 bits will be ignored
		await this.send_data((x_start>>3) & 0xFF)
		await this.send_data((x_end>>3) & 0xFF)
		 
		await this.send_command(0x45) // SET_RAM_Y_ADDRESS_START_END_POSITION
		await this.send_data(y_start & 0xFF)
		await this.send_data((y_start >> 8) & 0xFF)
		await this.send_data(y_end & 0xFF)
		await this.send_data((y_end >> 8) & 0xFF)
	}

	async SetCursor(x, y){
		await this.send_command(0x4E) // SET_RAM_X_ADDRESS_COUNTER
		 // x point must be the multiple of 8 or the last 3 bits will be ignored
		await this.send_data(x & 0xFF)
		 
		await this.send_command(0x4F) // SET_RAM_Y_ADDRESS_COUNTER
		await this.send_data(y & 0xFF)
		await this.send_data((y >> 8) & 0xFF)	
	}
	async init() {
		rpio.init({ mapping: 'physical' });
		rpio.open(RST_PIN, rpio.OUTPUT);
		rpio.open(DC_PIN, rpio.OUTPUT);
		rpio.open(CS_PIN, rpio.OUTPUT);
		rpio.open(BUSY_PIN, rpio.INPUT);

		this.spi = spi.openSync(0, 0, { maxSpeedHz: 400000 });

		// EPD hardware init start
		await this.reset();

		await this.readBusy();
		await this.send_command(0x12); // SWRESET
		await this.readBusy();

		await this.send_command(0x01); // Driver output control
		await this.send_data(0xf9);
		await this.send_data(0x00);
		await this.send_data(0x00);


		await this.send_command(0x11); // Data Entry Mode
		await this.send_data(0x03)

		await this.SetWindow(0,0, this.width-1, this.height-1)
		await this.SetCursor(0,0)

		await this.send_command(0x3C); 
		await this.send_data(0x05);

		await this.send_command(0x18); // Read built-in temperature sensor
		await this.send_data(0x80);

		await this.send_command(0x21); // Display update control
		await this.send_data(0x00);
		await this.send_data(0x80);


		await this.readBusy()

	}


	async display(black = []) {
		await this.send_command(0x24);
		await this.send_data(black)
	 	await this.TurnOnDisplay()
	}

	async displayFast(image) {
		await this.send_command(0x24);
		await this.send_data(image)
		await this.TurnOnDisplayFast()
	}

	async displayPartBaseImage(image) {
		await this.send_command(0x24);
		await this.send_buffer(image)

		await this.send_command(0x26);
		await this.send_buffer(image)
		await this.TurnOnDisplay() 
	}

	async prepareCanvas(canvas) {
		const image = await Image.fromCanvas(canvas);
		return await this.prepareImageBuffer(image);
	}

	async prepareImageFile(path) {
		return Image.load(path).then(this.prepareImageBuffer);
	}

	async prepareImageBuffer(image) {
		image = image.grey({ algorithm: 'minimum' })
        .rotate(image.width > image.height ? 90 : 0) // Rotate only if needed
        .resize({ width: DEVICE_WIDTH, height: DEVICE_HEIGHT })

		let accumulatedbits = [];
		for (let i = 0; i < image.height * image.width; i++) {
			accumulatedbits.push(image.getPixel(i)[0] < 128 ? 0 : 1);
			if ((i + 1) % DEVICE_WIDTH == 0) accumulatedbits.push(...Array(6).fill(1));
		}

		const output = Buffer.alloc(Math.floor(accumulatedbits.length / 8), 0x00);
		for (let i = 0; i < Math.floor(accumulatedbits.length / 8); i++) {
			let binStr = accumulatedbits.slice(i * 8, (i + 1) * 8).join('');
			output[i] = parseInt(binStr, 2);
		}

		return output;
	}

	async clear() {
		let linewidth = Math.trunc(DEVICE_WIDTH/8) + 1
		if ((DEVICE_WIDTH % 8) == 0) {
			linewidth = Math.trunc(DEVICE_WIDTH/8)
		} else {
			linewidth = Math.trunc(DEVICE_WIDTH/8) + 1
		}

		await this.send_command(0x24)
		await this.send_data(Buffer.alloc(linewidth*DEVICE_HEIGHT, 0xff))
		await this.TurnOnDisplay()
	}

	async wait(duration = 1000) {
		this.gpio.msleep(duration);
	}

	async sleep() {
		await this.send_command(0x10); // DEEP_SLEEP
		await this.send_data(0x01); // Check code

		await this.gpio.msleep(2000);

		console.log('spi end');
		this.spi.closeSync();

		console.log('close 5V, Module enters 0 power consumption ...');
		this.gpio.write(RST_PIN, 0);
		this.gpio.write(DC_PIN, 0);
		console.log('Pins shutdown');
	}
}

module.exports = epd2in13;
