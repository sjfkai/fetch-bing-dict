'use strict';
const fs = require('fs');
const mysql = require('mysql2/promise');
const requestPromise = require('request-promise');
const request = require('request');
const cheerio = require('cheerio');
const _ = require('lodash');

const thread = 10;
let pool; 

async function main() {
  // 连接数据库
  pool = mysql.createPool({host:'localhost', user: 'root', password: '123456', database: 'bing_dict'});
  const wordsInDb = await getWordsFromDb(pool);
  // 读词典
  let wordsIndict = fs.readFileSync('./dict.txt', 'utf8');
  wordsIndict = _.map(wordsIndict.split('\n'), word => word.trim());
  wordsIndict = _.filter(wordsIndict, word => !!word);
  const words = _.difference(wordsIndict, wordsInDb);
  console.log(`words: ${words.length}  wordsIndict: ${wordsIndict.length}  wordsInDb: ${wordsInDb.length}`);

  for (let i = 1; i <= thread; i++) {
    console.log(`thread ${i} start`);
    startWorker(i);
  }

  function startWorker(thread) {
    if (words.length === 0) {
      console.log(`thread ${thread} close`);
      return;
    }
    const word = words.pop();
    worker(word, thread).then(() => {
        startWorker(thread);
    });
  }
}


async function worker(word, thread) {
  // const word = 'flit';
  const {bingWord, usPronunciation, ukPronunciation, usMp3, ukMp3} = await searchFromBing(word, thread);
  // 下载
  await downloadMp3(word, 'us', usMp3, thread);
  await downloadMp3(word, 'uk', ukMp3, thread);
  // 保存
  const params = {
    word,
    bingWord,
    usPronunciation,
    ukPronunciation,
    usMp3,
    ukMp3,
  }
  await save(params);
  console.log(`Thread ${thread}: `, params);
}

/**
 * 取得已经抓去过的单词
 * @param {Object} pool 
 */
async function getWordsFromDb(thread) {
  const words = await pool.query('select word from dict');
  return _.map(words[0], 'word');
}

/**
 * 抓取必应的单词信息
 * @param {String} word 
 */
async function searchFromBing(word, thread, retryTimes = 0) {
  let res;
  try {
    res = await requestPromise(`http://cn.bing.com/dict/search?q=${ word }`, {
      timeout: 2000,
    });
  } catch (error) {
    console.log(`Thread ${thread}: search error`);
    return searchFromBing(word, thread);
  }
  const $ = cheerio.load(res);
  const bingWord = $('#headword > h1 > strong').text();
  let usPronunciation = $('.hd_prUS');
  usPronunciation = usPronunciation && usPronunciation.text().match(/\[.+\]/ig) && usPronunciation.text().match(/\[.+\]/ig)[0]
  let ukPronunciation = $('.hd_pr');
  ukPronunciation = ukPronunciation && ukPronunciation.text().match(/\[.+\]/ig) && ukPronunciation.text().match(/\[.+\]/ig)[0]
  let usMp3 = $('div.hd_tf_lh > div > div:nth-child(2) > a');
  usMp3 = usMp3 && usMp3.attr('onclick') && usMp3.attr('onclick').match(/https.+\.mp3/ig) && usMp3.attr('onclick').match(/https.+\.mp3/ig)[0]
  let ukMp3 = $('div.hd_tf_lh > div > div:nth-child(4) > a');
  ukMp3 = ukMp3 && ukMp3.attr('onclick') && ukMp3.attr('onclick').match(/https.+\.mp3/ig) && ukMp3.attr('onclick').match(/https.+\.mp3/ig)[0]
  if (!usPronunciation && !ukPronunciation && !usMp3 && !ukMp3 && retryTimes < 3) {
    console.log(`Thread ${thread}: retry ${word}`);
    return await searchFromBing(word, thread, retryTimes + 1);
  }
  return {
    bingWord,
    usPronunciation,
    ukPronunciation,
    usMp3,
    ukMp3,
  }
}

/**
 * 保存到数据库
 * @param {String} word 
 */
async function save({word, bingWord, usPronunciation = null, ukPronunciation = null, usMp3 = null, ukMp3 = null}) {
  await pool.execute('insert into dict values(null, ?, ?, ?, ?, ?, ?)', [word, bingWord, usPronunciation, ukPronunciation, usMp3, ukMp3]);
}

/**
 * 保存音频文件
 * @param {String} word 
 * @param {String} lang 
 * @param {String} url 
 */
function downloadMp3(word, lang, url, thread) {
  return new Promise((resolve, reject) => {
    console.log(`Thread ${thread}: downloading ${word} , ${lang}`);
    
    if (!word || !url) {
      resolve();
      return;
    }
    try {
      fs.mkdirSync(`./mp3/${lang}`);
    } catch (e) {}
    const requestStream = request.get(url, {
      timeout: 3000,
    })
    .on('error', function(err) {
      console.log(`Thread ${thread}: download ${word} , ${lang} error`);
      downloadMp3(word, lang, url, thread).then(() => {
        resolve();
        return;
      })
    })
    .on('end', () => {
      resolve();
      return;
    })
    .pipe(fs.createWriteStream(`./mp3/${lang}/${word}.mp3`))
  });
}

main().catch((error) => console.log(error.stack));