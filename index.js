const { Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, MessageFlags, ButtonStyle, PermissionsBitField, StringSelectMenuBuilder, InteractionWebhook } = require('discord.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildBans,
        GatewayIntentBits.GuildEmojisAndStickers,
        GatewayIntentBits.GuildIntegrations,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
        GatewayIntentBits.DirectMessageTyping,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildScheduledEvents,
    ],
    partials: [
        Partials.User,
        Partials.Channel,
        Partials.GuildMember,
        Partials.Message,
        Partials.Reaction,
        Partials.GuildScheduledEvent,
        Partials.ThreadMember,
    ]
});

require('dotenv').config();

const sqlite3 = require("sqlite3");
const db = new sqlite3.Database("./database.db");

const prefix = process.env.PREFIX || "!"

/* 仕様書
# roles
- villagers: 市民
- werewolves: 人狼
- seers: 占い師
- mediums: 霊媒師 (未実装)
- hunters: 狩人
- lunatics: 狂人 (未実装)
- foxes: 狐 (未実装)

# status(room)

- recruitment: 募集中
- processing: 処理中 メッセージの送信禁止
- discussion: 許可 一部スキル使用可能
- voting: 投票中
- end: 終了
- night: 夜


# 未修整の問題
- 人狼がランダム襲撃の対象になってしまう
*/

const promisifyDbGet = (db, query, params) => {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
};

const promisifyDbRun = (db, query, params) => {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
};

async function getMessageFromUrl(messageUrl) {
    const regex = /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/;
    const match = messageUrl.match(regex);

    if (!match) return null;

    const [, guildId, channelId, messageId] = match;

    try {
        const guild = await client.guilds.fetch(guildId);
        if (!guild) {
            console.error(`ギルドID ${guildId} が見つかりません。`);
            return null;
        }

        const channel = await guild.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) {
            console.error(`チャンネルID ${channelId} が見つからないか、テキストチャンネルではありません。`);
            return null;
        }

        const message = await channel.messages.fetch(messageId);
        return message;

    } catch (error) {
        return null;
    }
}

async function translateRole(roleName) {
    switch (roleName) {
        case 'villagers': return '市民';
        case 'werewolves': return '人狼';
        case 'seers': return '占い師';
        case 'mediums': return '霊媒師';
        case 'hunters': return '狩人';
        case 'lunatics': return '狂人';
        case 'foxes': return '狐';

        default: return roleName;
    }
}

async function getRoleComposition(roomId) {
    const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
    if (!room) return;

    const players = JSON.parse(room.players);
    const config = JSON.parse(room.config);

    if (!players || players.length === 0) {
        return '不明';
    }

    const roleCounts = {};
    let assignedRoles = 0;

    // 設定された役職の数をカウント
    for (const role in config) {
        if (role !== 'maxPlayers' && role !== 'showVoteTargets' && config[role] > 0) {
            roleCounts[role] = (roleCounts[role] || 0) + config[role];
            assignedRoles += config[role];
        }
    }

    // 余ったプレイヤーは市民
    const totalPlayers = players.length;
    if (totalPlayers > assignedRoles) {
        roleCounts['villagers'] = (roleCounts['villagers'] || 0) + (totalPlayers - assignedRoles);
    }

    if (Object.keys(roleCounts).length === 0) {
        return `市民: ${totalPlayers}人`;
    }

    let compositionString = '';
    for (const role in roleCounts) {
        const translatedRole = await translateRole(role);
        compositionString += `${translatedRole}: ${roleCounts[role]}人\n`;
    }

    return compositionString.trim();
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function assignRolesToPlayers(playersArray, configObject) {
    let roles = [];

    // configから'villagers'を除いた役職とその数を抽出
    const roleConfigs = {
        'werewolves': configObject.werewolves,
        'seers': configObject.seers,
        'mediums': configObject.mediums,
        'hunters': configObject.hunters,
        'lunatics': configObject.lunatics,
        'foxes': configObject.foxes
    };

    for (const roleName in roleConfigs) {
        const count = roleConfigs[roleName];
        if (count > 0) {
            for (let i = 0; i < count; i++) {
                roles.push(roleName);
            }
        }
    }

    // 残りのプレイヤーを全員'villagers'（市民）にする
    while (roles.length < playersArray.length) {
        roles.push("villagers");
    }

    // 役職がプレイヤー数より多い場合は切り詰める（エラーハンドリング）
    if (roles.length > playersArray.length) {
        roles = roles.slice(0, playersArray.length);
    }

    shuffleArray(playersArray);
    shuffleArray(roles);

    for (let i = 0; i < playersArray.length; i++) {
        playersArray[i].role = roles[i];
        // 人狼が割り当てられた場合、isBlackをtrueに設定
        if (roles[i] === 'werewolves') {
            playersArray[i].isBlack = true;
        }
    }
    return playersArray;
}

const delay = (ms) => new Promise(res => setTimeout(res, ms));

const game = {
    async register(msg, userId) {

        if (!msg || !userId) return;

        await promisifyDbRun(db, 'INSERT INTO player (userId, nick, admin, ban, createAt, joinRoomId, record, exp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            userId, // userId
            null, // nick
            0, // admin
            0, // ban
            Date.now(), // createAt
            null, // joinRoomId
            null, // record
            0 // exp
        ]);

        msg.edit({ content: "登録が完了しました！\n\nお困りの際は<#1389735956986204340>等をご覧ください！", allowedMentions: { repliedUser: false } });

    },
    async build(top, ownerId) {

        const guildId = top.guild.id;
        const channelId = top.channel.id;
        const topUrl = top.url;
        const roomId = Math.random().toString(36).slice(-6);

        if (!top || !ownerId || !channelId || !guildId) return;

        const config = {
            'maxPlayers': 0, // 0は制限なし(デフォルト値)
            'showVoteTargets': false,
            'villagers': 0,
            'werewolves': 0,
            'seers': 0,
            'mediums': 0,
            'hunters': 0,
            'freemasons': 0,
            'lunatics': 0,
            'foxes': 0
        };
        const players = [
            {
                'playerId': ownerId,
                'role': null,
                'skill': null,
                'isAlive': true,
                'isGuarded': false,
                'isBlack': false
            },
        ];

        await promisifyDbRun(db, 'INSERT INTO room (roomId, topUrl, ownerId, status, channelId, config, players) VALUES (?, ?, ?, ?, ?, ?, ?)', [roomId, topUrl, ownerId, 'recruitment', channelId, JSON.stringify(config), JSON.stringify(players)]);
        await promisifyDbRun(db, 'UPDATE player SET joinRoomId = ? WHERE userId = ?', [roomId, ownerId]);
        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);

        const embed = new EmbedBuilder()
            .setColor(0x808080) // グレー色
            .setTitle('Room ID: ' + room.roomId)
            .setDescription(
                `オーナー: <@${room.ownerId}>\n` +
                `最大人数: ${config.maxPlayers === 0 ? '制限なし' : config.maxPlayers}\n` +
                `投票先: ${config.showVoteTargets ? '開示する' : '開示しない'}`
            )
            .addFields(
                { name: '役職構成', value: `設定待ち` },
                { name: '現在参加者一覧', value: `<@${ownerId}>` }
            );
        const joinButton = new ButtonBuilder()
            .setCustomId('joinRoom')
            .setLabel('参加')
            .setStyle(ButtonStyle.Success);
        const leaveButton = new ButtonBuilder()
            .setCustomId('leaveRoom')
            .setLabel('退出')
            .setStyle(ButtonStyle.Danger);
        const settingButton = new ButtonBuilder()
            .setCustomId('settingRoom')
            .setLabel('設定')
            .setStyle(ButtonStyle.Secondary);
        const deleteButton = new ButtonBuilder()
            .setCustomId('deleteRoom')
            .setLabel('削除')
            .setStyle(ButtonStyle.Danger);
        const row = new ActionRowBuilder()
            .addComponents(joinButton, leaveButton, settingButton, deleteButton);

        await top.edit({ content: '', embeds: [embed], components: [row], allowedMentions: { repliedUser: false } });

    },
    async deleteRoom(roomId) {
        if (!roomId) return;

        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        const top = await getMessageFromUrl(room.topUrl);

        if (!room || !top) return;

        top.edit({ content: 'この部屋は削除されました', embeds: [], components: [], allowedMentions: { repliedUser: false } });

        // 部屋の参加者を更新
        await promisifyDbRun(db, 'UPDATE player SET joinRoomId = NULL WHERE joinRoomId = ?', [roomId]);

        // 部屋を削除
        // await promisifyDbRun(db, 'DELETE FROM room WHERE roomId = ?', [roomId]);

    },
    async join(roomId, playerId, msg) {
        if (!roomId || !playerId) return;

        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        if (!room) return;

        const players = JSON.parse(room.players);

        // 参加者数チェック
        if (players.length >= JSON.parse(room.config).maxPlayers && JSON.parse(room.config).maxPlayers !== 0) return;

        if (room.status !== 'recruitment') return msg.edit({ content: '現在参加できません', allowedMentions: { repliedUser: false } });

        // 参加者に追加
        players.push({
            playerId: playerId,
            role: null,
            skill: null,
            isAlive: true,
            isGuarded: false,
            isBlack: false
        });

        // db更新
        await promisifyDbRun(db, 'UPDATE room SET players = ? WHERE roomId = ?', [JSON.stringify(players), roomId]);
        await promisifyDbRun(db, 'UPDATE player SET joinRoomId = ? WHERE userId = ?', [roomId, playerId]);

        const top = await getMessageFromUrl(room.topUrl);

        await game.reloadTop(roomId)

        if (msg) return msg.edit({ content: `部屋ID ${roomId} に参加しました`, allowedMentions: { repliedUser: false } });

        return `部屋ID ${roomId} に参加しました`;
    },
    async reloadTop(roomId) {
        if (!roomId) return;

        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        if (!room) return;

        const top = await getMessageFromUrl(room.topUrl);
        if (!top) return;

        const config = JSON.parse(room.config);
        const players = JSON.parse(room.players);
        const roles = await getRoleComposition(roomId) || '設定待ち';
        const embed = new EmbedBuilder()
            .setColor(0x808080) // グレー色
            .setTitle('Room ID: ' + room.roomId)
            .setDescription(
                `オーナー: <@${room.ownerId}>\n` +
                `最大人数: ${config.maxPlayers === 0 ? '制限なし' : config.maxPlayers}\n` +
                `投票先: ${config.showVoteTargets ? '開示する' : '開示しない'}`
            )
            .addFields(
                { name: '役職構成', value: roles },
                { name: '現在参加者一覧', value: players.map(p => `<@${p.playerId}>`).join('\n') || 'なし' }
            );
        await top.edit({ content: '', embeds: [embed], allowedMentions: { repliedUser: false } });

        /*
        const roomId = await promisifyDbGet(db, 'SELECT roomId FROM room WHERE topUrl = ?', [top.url]);
        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        const config = JSON.parse(room.config);
        const players = JSON.parse(room.players);
        const roles = await getRoleComposition(roomId) || '設定待ち';

        const embed = new EmbedBuilder()
            .setColor(0x808080) // グレー色
            .setTitle('Room ID: ' + room.roomId)
            .setDescription(
                `オーナー: <@${room.ownerId}>\n` +
                `最大人数: ${config.maxPlayers === 0 ? '制限なし' : config.maxPlayers}\n` +
                `投票先: ${config.showVoteTargets ? '開示する' : '開示しない'}`
            )
            .addFields(
                { name: '役職構成', value: roles }, // ここではもう await は不要です
                { name: '現在参加者一覧', value: players.map(p => `<@${p.playerId}>`).join('\n') || 'なし' }
            );

        await top.edit({ content: '', embeds: [embed], allowedMentions: { repliedUser: false } });
        */

    },
    async leave(playerId) {
        if (!playerId) return;

        const player = await promisifyDbGet(db, 'SELECT * FROM player WHERE userId = ?', [playerId]);
        if (!player || !player.joinRoomId) return;

        const roomId = player.joinRoomId;
        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        if (!room) return;

        const players = JSON.parse(room.players).filter(p => p.playerId !== playerId);
        await promisifyDbRun(db, 'UPDATE room SET players = ? WHERE roomId = ?', [JSON.stringify(players), roomId]);

        await promisifyDbRun(db, 'UPDATE player SET joinRoomId = NULL WHERE userId = ?', [playerId]);

        await game.reloadTop(roomId);

        return `部屋ID ${roomId} から退出しました`;

    },
    async addRole(roomId) {
        if (!roomId) return;

        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        if (!room) return;

        let players = JSON.parse(room.players);
        const config = JSON.parse(room.config);

        players = assignRolesToPlayers(players, config);

        await promisifyDbRun(db, 'UPDATE room SET players = ? WHERE roomId = ?', [JSON.stringify(players), roomId]);

        await game.reloadTop(roomId);
    },
    async start(roomId) {
        if (!roomId) return;

        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        if (!room) return;

        const channel = await client.channels.fetch(room.channelId);

        if (room.status !== 'recruitment') return;
        if (JSON.parse(room.players).length < 3) return channel.send({ content: 'ゲームを開始するのに最低3人必要です' })

        // 処理中にする
        await promisifyDbRun(db, 'UPDATE room SET status = ? WHERE roomId = ?', ['processing', roomId]);

        const players = JSON.parse(room.players);
        const mentions = players.map(p => `<@${p.playerId}>`).join(' ');

        const roleButton = new ButtonBuilder()
            .setCustomId(`chuckleRole`)
            .setLabel('役職を確認')
            .setStyle(ButtonStyle.Primary);
        const row = new ActionRowBuilder()
            .addComponents(roleButton);

        await channel.send({ content: `### ゲーム開始！\n${mentions}`, allowedMentions: { parse: ['users'] } });

        await game.addRole(roomId);
        await game.reloadTop(roomId);
        await channel.send({ content: '次のボタンから自分の役職を確認してください', components: [row] });
        await channel.send({ content: await getRoleComposition(roomId) });
        await channel.send({ content: '**まだチャットできません**\n15秒後に議論開始' });
        await channel.send({ content: '\\\* 注意事項 \*\nあとでかく(書いてくれる人募集)' })

        await delay(15 * 1000);

        if (await game.end(roomId)) return channel.send({ content: await game.end(roomId) || 'ゲームは終了しました' });

        while (!await game.end(roomId)) {

            // 議論開始
            await promisifyDbRun(db, 'UPDATE room SET status = ? WHERE roomId = ?', ['discussion', roomId])
            await channel.send({ content: '**議論開始！**\nチャットが可能になりました', components: [] });

            // 議論 (5分)
            await delay(1 * 60 * 1000);
            await channel.send({ content: '残り4分' });
            await delay(1 * 60 * 1000);
            await channel.send({ content: '残り3分' });
            await delay(1 * 60 * 1000);
            await channel.send({ content: '残り2分' });
            await delay(1 * 60 * 1000);
            await channel.send({ content: '残り1分' });
            await delay(30 * 1000);
            await channel.send({ content: '残り30秒' });
            await delay(15 * 1000);
            await channel.send({ content: '残り15秒' });
            await delay(15 * 1000);

            // 投票 (60秒)
            await channel.send({ content: '投票を開始します(60秒)\n</vote:1395044303465742537>から投票' });
            await promisifyDbRun(db, 'UPDATE room SET status = ? WHERE roomId = ?', ['voting', roomId]);
            await delay(60 * 1000);
            await channel.send({ content: await game.punish(roomId) });

            if (await game.end(roomId)) break;

            // 夜 (60秒)
            await channel.send({ content: '夜の時間です(60秒)' });
            await promisifyDbRun(db, 'UPDATE room SET status = ? WHERE roomId = ?', ['night', roomId]);
            await delay(50 * 1000);
            await channel.send({ content: '残り10秒です' });
            await delay(10 * 1000);

            // 朝 (確認)
            await channel.send({ content: '夜が明けました' });
            await promisifyDbRun(db, 'UPDATE room SET status = ? WHERE roomId = ?', ['processing', roomId]);
            await channel.send({ content: await game.raid(roomId) });

        }

        await channel.send({ content: await game.end(roomId) || 'ゲームは終了しました' });
        await promisifyDbRun(db, 'UPDATE room SET status = ? WHERE roomId = ?', ['recruitment', roomId]);

        await game.reloadTop(roomId);
    },
    async end(roomId) {
        if (!roomId) return;

        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        if (!room) return;

        const players = JSON.parse(room.players);

        await promisifyDbRun(db, 'UPDATE room SET status = ?, players = ? WHERE roomId = ?', ['end', JSON.stringify(players), roomId]);

        // 人狼の数比較
        const alive = players.filter(p => p.isAlive);

        const werewolves = alive.filter(p => p.role === 'werewolves');
        const citizens = alive.filter(p => [
            'villagers',
            'seers',
            'mediums',
            'hunters'
        ].includes(p.role));

        if (werewolves.length >= citizens.length) return `人狼陣営の勝利`;

        if (!players.some(p => p.role === 'werewolves' && p.isAlive)) return `市民陣営の勝利`;

        return null;
    },
    async co(playerId, role) { },
    async skill(playerId, targetId) {
        if (!playerId || !targetId) return '対象を指定してください。';

        const player = await promisifyDbGet(db, 'SELECT * FROM player WHERE userId = ?', [playerId]);
        if (!player || !player.joinRoomId) return 'あなたはこのゲームに参加していません。';

        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
        if (!room) return '部屋が見つかりませんでした。';

        if (!room || (room.status !== 'voting' && room.status !== 'night')) return;

        let players = JSON.parse(room.players);
        const userPlayer = players.find(p => p.playerId === playerId);
        const targetPlayer = players.find(p => p.playerId === targetId);

        if (!userPlayer || !userPlayer.isAlive) return 'あなたは死亡しているか、役職がありません。';
        if (!targetPlayer) return '対象のプレイヤーが見つかりません。';

        // 自分自身を対象にできないスキルチェック
        if (userPlayer.role === 'hunters' && playerId === targetId) return '自分自身を護衛することはできません。';
        if (userPlayer.role === 'seers' && playerId === targetId) return '自分自身を占うことはできません。';


        switch (userPlayer.role) {
            case 'seers': {
                if (!targetPlayer.isAlive) return '対象のプレイヤーはすでに死亡しています。';

                const targetRoleData = players.find(p => p.playerId === targetId);
                const isBlack = targetRoleData.isBlack; // isBlackプロパティで判定
                return `占い結果: <@${targetId}> は ${isBlack ? '人狼' : '人狼ではない'} でした。`;
            }

            case 'hunters': {
                if (!targetPlayer.isAlive) return '対象のプレイヤーはすでに死亡しています。';

                players = players.map(p => {
                    if (p.playerId === targetId) {
                        p.isGuarded = true;
                    }
                    return p;
                });

                await promisifyDbRun(db, 'UPDATE room SET players = ? WHERE roomId = ?', [JSON.stringify(players), room.roomId]);
                return `<@${targetId}> を護衛しました。`;
            }

            case 'werewolves': {
                return await game.vote(playerId, targetId);
            }

            default:
                return 'あなたはこのスキルを使用できる役職ではありません。';
        }
    },
    async vote(playerId, targetId) {
        if (!playerId || !targetId) return;

        const player = await promisifyDbGet(db, 'SELECT * FROM player WHERE userId = ?', [playerId]);
        if (!player || !player.joinRoomId) return;

        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
        if (!room || room.status !== 'voting') return;

        const votes = JSON.parse(room.votes || '{}');

        // 投票済みならキャンセル
        for (const voted of Object.values(votes)) {
            if (voted.includes(playerId)) {
                return 'すでに投票済みです';
            }
        }

        // 投票先に記録
        if (!votes[targetId]) votes[targetId] = [];
        votes[targetId].push(playerId);

        await promisifyDbRun(db, 'UPDATE room SET votes = ? WHERE roomId = ?', [JSON.stringify(votes), room.roomId]);

        return `プレイヤー <@${targetId}> に投票しました`;
    },
    async punish(roomId) {
        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        if (!room) return;

        const votes = JSON.parse(room.votes || '{}');
        let players = JSON.parse(room.players);

        // 生存しているプレイヤーだけ抽出
        const alivePlayers = players.filter(p => p.isAlive);

        let punishedId;

        if (Object.keys(votes).length === 0) {
            if (alivePlayers.length === 0) return;
            punishedId = alivePlayers[Math.floor(Math.random() * alivePlayers.length)].playerId;
        } else {
            const voteCounts = Object.entries(votes).map(([targetId, voters]) => ({
                targetId,
                count: voters.length
            }));

            const maxCount = Math.max(...voteCounts.map(v => v.count));
            const topCandidates = voteCounts.filter(v => v.count === maxCount);

            // 同票ならランダム処刑
            punishedId = topCandidates[Math.floor(Math.random() * topCandidates.length)].targetId;
        }

        // isAlive 更新
        players = players.map(p => {
            if (p.playerId === punishedId) p.isAlive = false;
            return p;
        });

        await promisifyDbRun(db, 'UPDATE room SET players = ?, votes = ? WHERE roomId = ?', [
            JSON.stringify(players),
            JSON.stringify({}), // 次のラウンドに備えて votes をリセット
            roomId
        ]);

        return `投票${Object.keys(votes).length === 0 ? 'が無かったため' : 'の結果'}、<@${punishedId}> が処刑されました`;
    },
    async raid(roomId) {
        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        if (!room) return;

        const votes = JSON.parse(room.votes || '{}');
        let players = JSON.parse(room.players);

        // 生存しているプレイヤーだけ抽出
        const alivePlayers = players.filter(p => p.isAlive);

        // 人狼は襲撃の対象外
        const nonWerewolves = alivePlayers.filter(p => p.role !== 'werewolves');

        let punishedId;

        if (Object.keys(votes).length === 0) {
            if (nonWerewolves.length === 0) return;
            punishedId = nonWerewolves[Math.floor(Math.random() * nonWerewolves.length)].playerId;
        } else {
            const voteCounts = Object.entries(votes).map(([targetId, voters]) => ({
                targetId,
                count: voters.length
            }));

            // 投票対象が人狼の場合は除外
            const filteredVoteCounts = voteCounts.filter(v => nonWerewolves.some(p => p.playerId === v.targetId));
            if (filteredVoteCounts.length === 0) return;

            const maxCount = Math.max(...filteredVoteCounts.map(v => v.count));
            const topCandidates = filteredVoteCounts.filter(v => v.count === maxCount);

            // 同票ならランダム襲撃
            punishedId = topCandidates[Math.floor(Math.random() * topCandidates.length)].targetId;

        }

        // isAlive 更新（isGuardedがtrueならスキップ）
        players = players.map(p => {
            if (p.playerId === punishedId) {
                if (p.isGuarded) {
                    return p; // 襲撃失敗
                }
                p.isAlive = false;
            }
            return p;
        });

        await promisifyDbRun(db, 'UPDATE room SET players = ?, votes = ? WHERE roomId = ?', [
            JSON.stringify(players),
            JSON.stringify({}), // 次のラウンドに備えて votes をリセット
            roomId
        ]);

        const guardedPlayer = players.find(p => p.playerId === punishedId && p.isGuarded);

        if (guardedPlayer) {
            return `襲撃されたプレイヤーはいませんでした`;
        } else {
            return `<@${punishedId}> が襲撃されました`;
        }
    },
    async getPlayerRole(playerId) {
        if (!playerId) return

        const player = await promisifyDbGet(db, 'SELECT joinRoomId FROM player WHERE userId = ?', [playerId]);

        if (!player || !player.joinRoomId) return null;

        const roomId = player.joinRoomId;

        const room = await promisifyDbGet(db, 'SELECT players FROM room WHERE roomId = ?', [roomId]);

        if (!room) return null;

        const players = JSON.parse(room.players);
        const playerData = players.find(p => p.playerId === playerId);

        if (playerData) return playerData.role;

        return null;
    },
    async getRoomConfigList(roomId) {
        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
        if (!room) return '指定された部屋が見つかりません';

        const config = JSON.parse(room.config);
        const labels = {
            maxPlayers: '最大人数',
            showVoteTargets: '投票先の開示',
            villagers: '市民',

            seers: '占い師',
            // mediums: '霊媒師',
            hunters: '狩人',
            werewolves: '人狼',
            lunatics: '狂人'
            // foxes: '狐'
        };

        let result = '';
        for (const key in labels) {
            if (Object.prototype.hasOwnProperty.call(config, key)) {
                const value = config[key];
                result += `${labels[key]}: ${typeof value === 'boolean' ? (value ? '開示する' : '開示しない') : `${value}人`} \n`;
            }
        }

        return result.trim();
    },
    async getWerewolves(roomId) {
        if (!roomId) return null;

        const room = await promisifyDbGet(db, 'SELECT players FROM room WHERE roomId = ?', [roomId]); //
        if (!room) return null;

        const players = JSON.parse(room.players);
        const werewolves = players.filter(p => p.role === 'werewolves' && p.isAlive);

        if (werewolves.length === 0) {
            return;
        } else {
            return werewolves.map(p => `<@${p.playerId}>`).join('\n');
        }
    }
}

// CREATE TABLE player
db.run(
    `CREATE TABLE IF NOT EXISTS player(
    userId TEXT,
    nick TEXT,
    admin INTEGER,
    ban INTEGER,
    createAt INTEGER,
    joinRoomId TEXT,
    record TEXT,
    config TEXT,
    exp INTEGER
    )`
);

// CREATE TABLE room
db.run(
    `CREATE TABLE IF NOT EXISTS room(
    roomId TEXT,
    name TEXT,
    description TEXT,
    ownerId TEXT,
    password TEXT,
    createAt INTEGER,
    channelId TEXT,
    status TEXT,
    days INTEGER,
    votes TEXT,
    players TEXT,
    config TEXT,
    topUrl TEXT,
    type TEXT
    )`
);

process.on("uncaughtException", async (error) => {
    console.error(error);
});

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
});

client.on("messageCreate", async (message) => {

    const player = await promisifyDbGet(db, 'SELECT * FROM player WHERE userId = ?', [message.author.id]);

    // 発言禁止の処理
    if (player && player.joinRoomId) {
        if (message.author.bot) return
        const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
        const status = room.status;

        if (!room || !status) return;
        if (message.channel.id !== room.channelId) return

        if (status === 'processing' || status === 'night') {
            if (message.content && !message.content.startsWith(prefix)) {
                await message.delete();
                const msg = await message.channel.send({ content: '現在は発言できません' })
                await delay(5000)
                await msg.delete()
            }
        }

        const players = JSON.parse(room.players);
        const currentPlayer = players.find(p => p.playerId === message.author.id);

        if (currentPlayer && !currentPlayer.isAlive) {
            if (message.content && !message.content.startsWith(prefix)) {
                message.delete();
            }
        }
    }

    // コマンド
    if (message.content.startsWith(prefix)) {

        // setup
        if (message.content === prefix + "setup") {
            if (!message.guild || !message.member) return
            if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply({ content: '権限が不足しています\n-# あなたに管理者権限が必要です', allowedMentions: { repliedUser: false } })

            try {

                client.application.commands.set([])

                /*
                client.guilds.cache.get(message.guild.id).commands.create({
                    name: "co",
                    description: "役職をカミングアウトします",
                    options: [
                        {
                            name: "役職",
                            description: "カミングアウトする役職",
                            type: 3,
                        },
                    ],
                });
                */
                client.guilds.cache.get(message.guild.id).commands.create({
                    name: "vote",
                    description: "指定したプレイヤーに投票します",
                    options: [
                        {
                            name: "target",
                            description: "投票対象となるユーザー",
                            type: 6, // USER type
                            required: true
                        },
                    ],
                });
                client.guilds.cache.get(message.guild.id).commands.create({
                    name: "raid",
                    description: "人狼が襲撃するプレイヤーを選択します",
                    options: [
                        {
                            name: "target",
                            description: "襲撃対象となるユーザー",
                            type: 6, // USER type
                            required: true
                        },
                    ],
                });
                client.guilds.cache.get(message.guild.id).commands.create({
                    name: "skill",
                    description: "役職に基づいた能力を使用します",
                    options: [
                        {
                            name: "target",
                            description: "対象となるユーザー",
                            type: 6 // USER type
                        },
                    ],
                });

                await message.react('✅')

            } catch (err) {
                console.err(err)
                await message.react('❌')
            }

        }

        // exit
        if (message.content === prefix + 'exit') {

            const owner = client.application.owner;
            let isOwner = false;

            if (owner && owner.id === message.author.id) { // Userオブジェクトの場合
                isOwner = true;
            } else if (owner && owner.members && owner.members.has(message.author.id)) { // Teamオブジェクトの場合
                isOwner = true;
            }

            if (!isOwner || !player.admin) return message.channel.send('あなたの権限が不足しています');

            message.react('✅')
            await client.destroy();
        }

        // register
        if (message.content === prefix + 'register' || message.content === prefix + 'reg') {

            if (player) return message.reply({ content: '既に登録済みです', allowedMentions: { repliedUser: false } })

            const msg = await message.reply({ content: "処理中...", allowedMentions: { repliedUser: false } })
            game.register(msg, message.author.id)

        }

        // build
        if (message.content === prefix + 'build' || message.content === prefix + 'b') {

            if (!player) return message.reply({ content: `あなたのプレイヤーデータが見つかりませんでした。\n-# ${prefix}regで登録`, allowedMentions: { repliedUser: false } })
            if (player.joinRoomId) return message.reply({ content: '既に他の部屋に参加済みです', allowedMentions: { repliedUser: false } });

            const top = await message.reply({ content: '処理中...', allowedMentions: { repliedUser: false } });
            game.build(top, message.author.id);

        }

        // deleteRoom
        if (message.content === prefix + 'deleteRoom' || message.content === prefix + 'dr') {
            if (!player) return message.reply({ content: `あなたのプレイヤーデータが見つかりませんでした。\n-# ${prefix}regで登録`, allowedMentions: { repliedUser: false } });
            if (!player.joinRoomId) return message.reply({ content: '現在参加している部屋がありません', allowedMentions: { repliedUser: false } });

            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!room) return message.reply({ content: '現在参加している部屋が見つかりません', allowedMentions: { repliedUser: false } });
            if (room.ownerId !== player.userId) return message.reply({ content: 'あなたはこの部屋のオーナーではありません', allowedMentions: { repliedUser: false } });

            await game.deleteRoom(player.joinRoomId);
            message.reply({ content: '部屋を削除しました', allowedMentions: { repliedUser: false } });
        }

        // join
        if (message.content.startsWith(prefix + 'join') || message.content.startsWith(prefix + 'j')) {

            if (!player) return message.reply({ content: `あなたのプレイヤーデータが見つかりませんでした。\n-# ${prefix}regで登録`, allowedMentions: { repliedUser: false } })
            if (player.joinRoomId) return message.reply({ content: '既に他の部屋に参加済みです', allowedMentions: { repliedUser: false } });

            const msg = await message.reply({ content: '処理中...', allowedMentions: { repliedUser: false } });

            // topメッセージに返信している場合その部屋に参加
            if (message.reference) {

                const repliedMessageId = message.reference.messageId;
                const repliedChannelId = message.reference.channelId;
                const channel = await client.channels.fetch(repliedChannelId);

                const top = await getMessageFromUrl(`https://discord.com/channels/${channel.guild.id}/${channel.id}/${repliedMessageId}`);
                if (!top) return;

                const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE topUrl = ?', [top.url]);

                game.join(room.roomId, message.author.id, msg);

            } else if (message.content.includes(' ')) { // 部屋IDを指定して参加

                const roomId = message.content.split(' ')[1];
                if (!roomId) return msg.edit({ content: '部屋IDを指定してください', allowedMentions: { repliedUser: false } });

                const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
                if (!room) return msg.edit({ content: '指定された部屋が見つかりません', allowedMentions: { repliedUser: false } });

                // 参加者数チェック
                const players = JSON.parse(room.players);
                if (players.length >= JSON.parse(room.config).maxPlayers && JSON.parse(room.config).maxPlayers !== 0) {
                    return msg.edit({ content: 'この部屋は満員です', allowedMentions: { repliedUser: false } });
                }

                game.join(roomId, message.author.id, msg);

            }
        }

        // leave
        if (message.content === prefix + 'leave' || message.content === prefix + 'l') {

            if (!player) return message.reply({ content: 'あなたのプレイヤーデータが見つかりませんでした。\n-# 登録: ' + prefix + 'reg', allowedMentions: { repliedUser: false } })
            if (!player.joinRoomId) return message.reply({ content: '参加している部屋がありません', allowedMentions: { repliedUser: false } })

            // 参加している部屋のオーナーは退出不可
            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (room.ownerId === player.userId) return message.reply({ content: `部屋のオーナーは退出できません\n-# 部屋の削除: ${prefix}dr`, allowedMentions: { repliedUser: false } });

            const msg = await message.reply({ content: '処理中...', allowedMentions: { repliedUser: false } });

            game.leave(message.author.id, msg);

        }

        // reload
        if (message.content.startsWith(prefix + 'reload') || message.content.startsWith(prefix + 'r')) {
            if (message.content === prefix + 'register' || message.content === prefix + 'reg') return; // registerコマンドは除外{

            const roomId = message.content.split(' ')[1];

            if (roomId) {
                const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
                if (!room) return message.reply({ content: '指定された部屋が見つかりません', allowedMentions: { repliedUser: false } });

                await game.reloadTop(roomId);
                await message.react('✅');
            } else {

                if (!player) return message.reply({ content: 'あなたのプレイヤーデータが見つかりませんでした。\n-# 登録: ' + prefix + 'reg', allowedMentions: { repliedUser: false } })
                if (!player.joinRoomId) return message.reply({ content: '参加している部屋がありません', allowedMentions: { repliedUser: false } })

                const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
                if (!room) return message.reply({ content: '現在参加している部屋が見つかりません', allowedMentions: { repliedUser: false } });

                const top = await getMessageFromUrl(room.topUrl);
                if (!top) return message.reply({ content: 'トップメッセージが見つかりません', allowedMentions: { repliedUser: false } });

                await game.reloadTop(room.roomId);
                await message.react('✅');
            }
        }

        // start
        if (message.content === prefix + 'start' || message.content === prefix + 's') {
            if (!player) return message.reply({ content: 'あなたのプレイヤーデータが見つかりませんでした。\n-# 登録: ' + prefix + 'reg', allowedMentions: { repliedUser: false } })
            if (!player.joinRoomId) return message.reply({ content: '参加している部屋がありません', allowedMentions: { repliedUser: false } })

            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!room) return message.reply({ content: '現在参加している部屋が見つかりません', allowedMentions: { repliedUser: false } });
            if (room.ownerId !== player.userId) return message.reply({ content: 'あなたはこの部屋のオーナーではありません', allowedMentions: { repliedUser: false } });

            game.start(room.roomId);
        }

    } else {
        if (!player || !player.config) return;
        const config = JSON.parse(player.config);
        if (!config.shortcut) return;

        // build
        if (message.content === 'build' || message.content === 'b') {

            if (!player) return message.reply({ content: `あなたのプレイヤーデータが見つかりませんでした。\n-# ${prefix}regで登録`, allowedMentions: { repliedUser: false } })
            if (player.joinRoomId) return message.reply({ content: '既に他の部屋に参加済みです', allowedMentions: { repliedUser: false } });

            const top = await message.reply({ content: '処理中...', allowedMentions: { repliedUser: false } });
            game.build(top, message.author.id);

        }

        // deleteRoom
        if (message.content === 'deleteRoom' || message.content === 'dr') {
            if (!player) return message.reply({ content: `あなたのプレイヤーデータが見つかりませんでした。\n-# ${prefix}regで登録`, allowedMentions: { repliedUser: false } });

            if (!player.joinRoomId) return message.reply({ content: '現在参加している部屋がありません', allowedMentions: { repliedUser: false } });

            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);

            if (!room) return message.reply({ content: '現在参加している部屋が見つかりません', allowedMentions: { repliedUser: false } });

            if (room.ownerId !== player.userId) return message.reply({ content: 'あなたはこの部屋のオーナーではありません', allowedMentions: { repliedUser: false } });

            await game.deleteRoom(player.joinRoomId);
            message.reply({ content: '部屋を削除しました', allowedMentions: { repliedUser: false } });
        }

        // join
        if (message.content.startsWith('join') || message.content.startsWith('j')) {

            if (!player) return message.reply({ content: `あなたのプレイヤーデータが見つかりませんでした。\n-# ${prefix}regで登録`, allowedMentions: { repliedUser: false } })
            if (player.joinRoomId) return message.reply({ content: '既に他の部屋に参加済みです', allowedMentions: { repliedUser: false } });

            const msg = await message.reply({ content: '処理中...', allowedMentions: { repliedUser: false } });

            // topメッセージに返信している場合その部屋に参加
            if (message.reference) {

                const repliedMessageId = message.reference.messageId;
                const repliedChannelId = message.reference.channelId;
                const channel = await client.channels.fetch(repliedChannelId);

                const top = await getMessageFromUrl(`https://discord.com/channels/${channel.guild.id}/${channel.id}/${repliedMessageId}`);
                if (!top) return;

                const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE topUrl = ?', [top.url]);

                game.join(room.roomId, message.author.id, msg);

            } else if (message.content.includes(' ')) { // 部屋IDを指定して参加

                const roomId = message.content.split(' ')[1];
                if (!roomId) return msg.edit({ content: '部屋IDを指定してください', allowedMentions: { repliedUser: false } });

                const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
                if (!room) return msg.edit({ content: '指定された部屋が見つかりません', allowedMentions: { repliedUser: false } });

                // 参加者数チェック
                const players = JSON.parse(room.players);
                if (players.length >= JSON.parse(room.config).maxPlayers && JSON.parse(room.config).maxPlayers !== 0) {
                    return msg.edit({ content: 'この部屋は満員です', allowedMentions: { repliedUser: false } });
                }

                game.join(roomId, message.author.id, msg);

            }
        }

        // leave
        if (message.content === 'leave' || message.content === 'l') {

            if (!player) return message.reply({ content: 'あなたのプレイヤーデータが見つかりませんでした。\n-# 登録: ' + prefix + 'reg', allowedMentions: { repliedUser: false } })
            if (!player.joinRoomId) return message.reply({ content: '参加している部屋がありません', allowedMentions: { repliedUser: false } })

            // 参加している部屋のオーナーは退出不可
            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (room.ownerId === player.userId) return message.reply({ content: `部屋のオーナーは退出できません\n-# 部屋の削除: ${prefix}dr`, allowedMentions: { repliedUser: false } });

            const msg = await message.reply({ content: '処理中...', allowedMentions: { repliedUser: false } });

            game.leave(message.author.id, msg);

        }

        // reload
        if (message.content.startsWith('reload') || message.content.startsWith('r')) {
            if (message.content === prefix + 'register' || message.content === prefix + 'reg') return; // registerコマンドは除外{

            const roomId = message.content.split(' ')[1];

            if (roomId) {
                const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [roomId]);
                if (!room) return message.reply({ content: '指定された部屋が見つかりません', allowedMentions: { repliedUser: false } });

                await game.reloadTop(roomId);
                await message.react('✅');
            } else {

                if (!player) return message.reply({ content: 'あなたのプレイヤーデータが見つかりませんでした。\n-# 登録: ' + prefix + 'reg', allowedMentions: { repliedUser: false } })
                if (!player.joinRoomId) return message.reply({ content: '参加している部屋がありません', allowedMentions: { repliedUser: false } })

                const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
                if (!room) return message.reply({ content: '現在参加している部屋が見つかりません', allowedMentions: { repliedUser: false } });

                await game.reloadTop(room.roomId);
                await message.react('✅');
            }
        }

        // start
        if (message.content === 'start' || message.content === 's') {
            if (!player) return message.reply({ content: 'あなたのプレイヤーデータが見つかりませんでした。\n-# 登録: ' + prefix + 'reg', allowedMentions: { repliedUser: false } })
            if (!player.joinRoomId) return message.reply({ content: '参加している部屋がありません', allowedMentions: { repliedUser: false } })

            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!room) return message.reply({ content: '現在参加している部屋が見つかりません', allowedMentions: { repliedUser: false } });
            if (room.ownerId !== player.userId) return message.reply({ content: 'あなたはこの部屋のオーナーではありません', allowedMentions: { repliedUser: false } });

            game.start(room.roomId);
        }

    }

})

client.on("interactionCreate", async (interaction) => {

    const player = await promisifyDbGet(db, 'SELECT * FROM player WHERE userId = ?', [interaction.user.id]);

    if (interaction.isChatInputCommand()) {

        if (interaction.commandName === "vote") {
            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!player || !room) return interaction.reply({ content: '現在は使用できません', flags: MessageFlags.Ephemeral });
            if (room.status !== 'voting') return interaction.reply({ content: '現在投票中ではありません', flags: MessageFlags.Ephemeral });
            const isAlive = JSON.parse(room.players).find(p => p.playerId === interaction.user.id)?.isAlive;
            if (!isAlive) return interaction.reply({ content: 'あなたは既に死亡しています', flags: MessageFlags.Ephemeral });
            if (!interaction.options.getUser("target")) return interaction.reply({ content: '投票対象を指定してください', flags: MessageFlags.Ephemeral });
            if (interaction.options.getUser("target").id === interaction.user.id) return interaction.reply({ content: '自分に投票することはできません', flags: MessageFlags.Ephemeral });

            const voterId = interaction.user.id;
            const targetUser = interaction.options.getUser("target");
            const targetId = targetUser?.id;

            if (!targetId) return interaction.reply({ content: '対象ユーザーが取得できませんでした', flags: MessageFlags.Ephemeral });

            const result = await game.vote(voterId, targetId);
            // 投票を公開する場合、MessageFlags.Ephemeralを外す
            if (JSON.parse(room.config).showVoteTargets) {
                interaction.reply({ content: result, flags: MessageFlags.Ephemeral });
            } else {
                interaction.reply({ content: result });
            }
        }

        if (interaction.commandName === "raid") {
            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!player || !room) return interaction.reply({ content: '現在は使用できません', flags: MessageFlags.Ephemeral });
            if (room.status !== 'night') return interaction.reply({ content: '現在は夜ではありません', flags: MessageFlags.Ephemeral });

            const players = JSON.parse(room.players);
            const userPlayerData = players.find(p => p.playerId === interaction.user.id);

            if (!userPlayerData || !userPlayerData.isAlive) return interaction.reply({ content: 'あなたは既に死亡しています', flags: MessageFlags.Ephemeral });
            if (userPlayerData.role !== 'werewolves') return interaction.reply({ content: '人狼のみがこのコマンドを使用できます', flags: MessageFlags.Ephemeral });

            const targetUser = interaction.options.getUser("target");
            if (!targetUser) return interaction.reply({ content: '襲撃対象を指定してください', flags: MessageFlags.Ephemeral });
            const targetId = targetUser.id;

            const targetPlayerData = players.find(p => p.playerId === targetId);
            if (!targetPlayerData) return interaction.reply({ content: '指定されたプレイヤーは部屋に参加していません', flags: MessageFlags.Ephemeral });
            if (targetPlayerData.role === 'werewolves') return interaction.reply({ content: '他の人狼を襲撃することはできません', flags: MessageFlags.Ephemeral });

            const result = await game.skill(interaction.user.id, targetId);
            return interaction.reply({ content: result, flags: MessageFlags.Ephemeral });
        }

        if (interaction.commandName === "skill") {
            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!player || !room) return interaction.reply({ content: '現在は使用できません', flags: MessageFlags.Ephemeral });

            const targetUser = interaction.options.getUser("target");
            const targetId = targetUser.id;

            const result = await game.skill(interaction.user.id, targetId);
            return interaction.reply({ content: result, flags: MessageFlags.Ephemeral });
        }

        if (interaction.commandName === "guard") {
            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!player || !room) return interaction.reply({ content: '現在は使用できません', flags: MessageFlags.Ephemeral });
            if (room.status !== 'night') return interaction.reply({ content: '現在は夜ではありません', flags: MessageFlags.Ephemeral });

            const players = JSON.parse(room.players);
            const userPlayerData = players.find(p => p.playerId === interaction.user.id);

            if (!userPlayerData || !userPlayerData.isAlive) return interaction.reply({ content: 'あなたは既に死亡しています', flags: MessageFlags.Ephemeral });
            if (userPlayerData.role !== 'hunters') return interaction.reply({ content: '狩人のみがこのコマンドを使用できます', flags: MessageFlags.Ephemeral });

            const targetUser = interaction.options.getUser("target");
            if (!targetUser) return interaction.reply({ content: '護衛対象を指定してください', flags: MessageFlags.Ephemeral });
            const targetId = targetUser.id;

            const result = await game.skill(interaction.user.id, targetId);
            return interaction.reply({ content: result, flags: MessageFlags.Ephemeral });
        }
    }

    if (interaction.isButton()) {

        if (interaction.customId === 'joinRoom') {
            if (player.joinRoomId) return interaction.reply({ content: '既に他の部屋に参加済みです', flags: MessageFlags.Ephemeral });

            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [interaction.message.embeds[0].title.split(': ')[1]]);
            if (!room) return interaction.reply({ content: '部屋が見つかりません', flags: MessageFlags.Ephemeral });

            interaction.reply({ content: await game.join(room.roomId, interaction.user.id), flags: MessageFlags.Ephemeral });
        }

        if (interaction.customId === 'leaveRoom') {
            if (!player.joinRoomId) return interaction.reply({ content: '参加している部屋がありません', flags: MessageFlags.Ephemeral });

            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!room) return interaction.reply({ content: '現在参加している部屋が見つかりません', flags: MessageFlags.Ephemeral });

            game.leave(interaction.user.id, interaction.message);
        }

        if (interaction.customId === 'settingRoom') {

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('現在設定')
                .setDescription('Some description here')
                .addFields(
                    { name: '\u200B', value: '\u200B' },
                )
                .setFooter({ text: '\u200B' })

            const selectRow = new ActionRowBuilder()
                .addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId('configRoomSelect')
                        .setPlaceholder('選択してください')
                        .addOptions([
                            {
                                label: '最大人数',
                                description: 'プレイヤーの最大人数を設定します(0で無制限)',
                                value: 'configRoom_maxPlayers',
                            },
                            {
                                label: '投票先の開示の有無',
                                description: '投票先を開示するかどうかを設定します',
                                value: 'configRoom_showVoteTargets',
                            },
                            {
                                label: '占い師の人数',
                                description: '占い師の人数を設定します',
                                value: 'configRoom_seers',
                            },
                            // {
                            //     label: '霊媒師の人数',
                            //     description: '霊媒師の人数を設定します',
                            //     value: 'configRoom_mediums',
                            // },
                            {
                                label: '狩人の人数',
                                description: '狩人の人数を設定します',
                                value: 'configRoom_hunters',
                            },
                            {
                                label: '人狼の人数',
                                description: '人狼の人数を設定します',
                                value: 'configRoom_werewolves',
                            },
                            {
                                label: '狂人の人数',
                                description: '狂人の人数を設定します',
                                value: 'configRoom_lunatics',
                            }
                            // {
                            //     label: '狐の人数',
                            //     description: '狐の人数を設定します',
                            //     value: 'configRoom_foxes'
                            // }
                        ]),
                );
            const buttonRow = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('configRoomLeft')
                        .setLabel('<')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('closeConfigRoom')
                        .setLabel('閉じる')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('configRoomRight')
                        .setLabel('>')
                        .setStyle(ButtonStyle.Secondary)
                );

            interaction.reply({ embeds: [embed], components: [selectRow, buttonRow] })
        }

        if (interaction.customId === 'closeConfigRoom') {
            await interaction.message.delete();
        }

        if (interaction.customId === 'deleteRoom') {
            if (!player || !player.joinRoomId) return

            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!room) return interaction.reply({ content: '現在参加している部屋が見つかりません', flags: MessageFlags.Ephemeral });
            if (room.ownerId !== player.userId) return interaction.reply({ content: 'あなたはこの部屋のオーナーではありません', flags: MessageFlags.Ephemeral });

            await game.deleteRoom(player.joinRoomId);
            interaction.reply({ content: '部屋を削除しました', flags: MessageFlags.Ephemeral });
        }

        if (interaction.customId === 'configRoomLeft' || interaction.customId === 'configRoomRight') {
            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!room) return interaction.reply({ content: '現在参加している部屋が見つかりません', flags: MessageFlags.Ephemeral });

            const config = JSON.parse(room.config);
            const currentConfig = interaction.message.embeds[0].footer.text;

            let newValue;
            if (interaction.customId === 'configRoomLeft') {
                newValue = Math.max(0, config[currentConfig] - 1);
            } else {
                newValue = config[currentConfig] + 1;
            }

            config[currentConfig] = newValue;

            await promisifyDbRun(db, 'UPDATE room SET config = ? WHERE roomId = ?', [JSON.stringify(config), player.joinRoomId]);

            const embed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle('設定更新')
                .setDescription(await game.getRoomConfigList(room.roomId))
                .addFields(
                    { name: await translateRole(currentConfig) || currentConfig, value: `新しい値: ${newValue}` }
                )
                .setFooter({ text: currentConfig });

            interaction.update({ embeds: [embed] });
        }

        if (interaction.customId === 'chuckleRole') {
            if (!player || !player.joinRoomId) return interaction.reply({ content: '参加している部屋がありません', flags: MessageFlags.Ephemeral }); //

            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE roomId = ?', [player.joinRoomId]);
            if (!room) return interaction.reply({ content: '現在参加している部屋が見つかりません', flags: MessageFlags.Ephemeral });

            const players = JSON.parse(room.players);
            const playerData = players.find(p => p.playerId === player.userId);
            if (!playerData || !playerData.role) return interaction.reply({ content: 'あなたの役職が設定されていません', flags: MessageFlags.Ephemeral }); //

            let replyContent = `あなたの役職は **${await translateRole(playerData.role)}** です`;

            if (playerData.role === 'werewolves') {
                const werewolvesList = await game.getWerewolves(room.roomId);
                if (werewolvesList) {
                    replyContent += `\n\n仲間は以下の通りです:\n${werewolvesList}`;
                }
            }

            interaction.reply({ content: replyContent, flags: MessageFlags.Ephemeral }); //
        }

        /*
        if (interaction.customId === 'necromancy') {
            if (!player) return;

            if (game.getPlayerRole(interaction.author.id) !== 'mediums') return;
        }
            */
    }

    if (interaction.isStringSelectMenu()) {

        if (interaction.customId === 'configRoomSelect') {

            const repliedMessageId = interaction.message.reference.messageId;

            const top = await interaction.channel.messages.fetch(repliedMessageId);

            const room = await promisifyDbGet(db, 'SELECT * FROM room WHERE topUrl = ?', [top.url]);

            const config = JSON.parse(room.config);
            const currentConfig = interaction.message.embeds[0].footer.text;

            let newValue;
            if (interaction.customId === 'configRoomLeft') {
                newValue = Math.max(0, config[currentConfig] - 1);
            } else {
                newValue = config[currentConfig] + 1;
            }

            config[currentConfig] = newValue;

            if (interaction.values[0] === 'configRoom_maxPlayers') {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('最大人数の設定')
                    .setDescription(await game.getRoomConfigList(room.roomId))
                    .addFields(
                        { name: '最大人数', value: '0で無制限、1以上で制限あり' }
                    )
                    .setFooter({ text: 'maxPlayers' });

                interaction.update({ embeds: [embed] });
            } else if (interaction.values[0] === 'configRoom_showVoteTargets') {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('投票先の開示の有無')
                    .setDescription(await game.getRoomConfigList(room.roomId))
                    .addFields(
                        { name: '投票先の開示', value: 'trueで開示、falseで非開示' }
                    )
                    .setFooter({ text: 'showVoteTargets' });

                interaction.update({ embeds: [embed] });

            } else if (interaction.values[0] === 'configRoom_seers') {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('占い師の人数の設定')
                    .setDescription(await game.getRoomConfigList(room.roomId))
                    .addFields(
                        { name: '占い師の人数', value: '0以上の整数' }
                    )
                    .setFooter({ text: 'seers' });

                interaction.update({ embeds: [embed] });
            } else if (interaction.values[0] === 'configRoom_mediums') {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('霊媒師の人数の設定')
                    .setDescription(await game.getRoomConfigList(room.roomId))
                    .addFields(
                        { name: '霊媒師の人数', value: '0以上の整数' }
                    )
                    .setFooter({ text: 'mediums' });

                interaction.update({ embeds: [embed] });
            } else if (interaction.values[0] === 'configRoom_hunters') {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('狩人の人数の設定')
                    .setDescription(await game.getRoomConfigList(room.roomId))
                    .addFields(
                        { name: '狩人の人数', value: '0以上の整数' }
                    )
                    .setFooter({ text: 'hunters' });

                interaction.update({ embeds: [embed] });
            } else if (interaction.values[0] === 'configRoom_werewolves') {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('人狼の人数の設定')
                    .setDescription(await game.getRoomConfigList(room.roomId))
                    .addFields(
                        { name: '人狼の人数', value: '0以上の整数' }
                    )
                    .setFooter({ text: 'werewolves' });

                interaction.update({ embeds: [embed] });
            } else if (interaction.values[0] === 'configRoom_lunatics') {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('狂人の人数の設定')
                    .setDescription(await game.getRoomConfigList(room.roomId))
                    .addFields(
                        { name: '狂人の人数', value: '0以上の整数' }
                    )
                    .setFooter({ text: 'lunatics' });

                interaction.update({ embeds: [embed] });
            } else if (interaction.values[0] === 'configRoom_foxes') {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle('狐の人数の設定')
                    .setDescription(await game.getRoomConfigList(room.roomId))
                    .addFields(
                        { name: '狐の人数', value: '0以上の整数' }
                    )
                    .setFooter({ text: 'foxes' });

                interaction.update({ embeds: [embed] });
            }
        }

    }
})

client.login(process.env.TOKEN);
