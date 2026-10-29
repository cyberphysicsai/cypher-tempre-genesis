// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Permanent, wallet-owned seats bound to opaque local bridge key hashes.
/// @dev No administrator, proxy, withdrawal, account database, or transfer market.
///      This registry proves paid bindings, not unique hardware or concurrency.
contract CypherTempreSeats is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant UNIT_PRICE = 21_000 * 10 ** 18;
    uint256 public constant MAX_BATCH = 64;
    IERC20 public immutable token;
    address public immutable treasury;
    uint256 public totalSeats;

    struct Seat {
        address owner;
        uint64 generation;
        bytes32 deviceKey;
    }

    mapping(uint256 => Seat) public seats;
    // A public key commitment is not proof of ownership. Scope it to the payer
    // so another wallet cannot squat on a key observed in a pending purchase.
    mapping(address => mapping(bytes32 => uint256)) public seatOfDevice;

    error InvalidToken();
    error InvalidTreasury();
    error InvalidQuantity();
    error InvalidDeviceKey();
    error DeviceAlreadyBound(bytes32 deviceKey);
    error NotSeatOwner();
    error SeatAlreadyBound();
    error SeatNotBound();
    error DeviceUnchanged();
    error PaymentAmountMismatch(uint256 expected, uint256 received);

    event SeatsPurchased(
        address indexed owner,
        uint256 indexed firstSeatId,
        uint256 quantity,
        uint256 amount
    );
    event SeatBound(uint256 indexed seatId, bytes32 indexed deviceKey, uint64 generation);
    event SeatRotated(
        uint256 indexed seatId,
        bytes32 indexed previousDeviceKey,
        bytes32 indexed deviceKey,
        uint64 generation
    );

    constructor(address token_, address treasury_) {
        if (token_ == address(0) || token_.code.length == 0) revert InvalidToken();
        if (IERC20Metadata(token_).decimals() != 18) revert InvalidToken();
        if (treasury_ == address(0) || treasury_ == address(this) || treasury_ == token_) {
            revert InvalidTreasury();
        }
        token = IERC20(token_);
        treasury = treasury_;
    }

    /// @notice Buy unbound seats owned by the paying wallet.
    function purchase(uint256 quantity) external nonReentrant returns (uint256 firstSeatId) {
        _validateQuantity(quantity);
        firstSeatId = totalSeats + 1;
        for (uint256 i; i < quantity; ++i) {
            seats[++totalSeats].owner = msg.sender;
        }
        _collectPayment(quantity);
        emit SeatsPurchased(msg.sender, firstSeatId, quantity, quantity * UNIT_PRICE);
    }

    /// @notice Buy and bind seats atomically. Any failure reverts the entire purchase.
    function purchaseAndBind(bytes32[] calldata deviceKeys)
        external
        nonReentrant
        returns (uint256 firstSeatId)
    {
        uint256 quantity = deviceKeys.length;
        _validateQuantity(quantity);
        firstSeatId = totalSeats + 1;
        for (uint256 i; i < quantity; ++i) {
            _validateDeviceKey(deviceKeys[i]);
            uint256 seatId = ++totalSeats;
            seats[seatId] = Seat(msg.sender, 1, deviceKeys[i]);
            seatOfDevice[msg.sender][deviceKeys[i]] = seatId;
            emit SeatBound(seatId, deviceKeys[i], 1);
        }
        _collectPayment(quantity);
        emit SeatsPurchased(msg.sender, firstSeatId, quantity, quantity * UNIT_PRICE);
    }

    /// @notice Assign an unbound seat. Only its purchasing wallet can do this.
    function bind(uint256 seatId, bytes32 deviceKey) external nonReentrant {
        Seat storage seat = seats[seatId];
        if (seat.owner != msg.sender) revert NotSeatOwner();
        if (seat.deviceKey != bytes32(0)) revert SeatAlreadyBound();
        _validateDeviceKey(deviceKey);
        seat.deviceKey = deviceKey;
        seat.generation = 1;
        seatOfDevice[msg.sender][deviceKey] = seatId;
        emit SeatBound(seatId, deviceKey, 1);
    }

    /// @notice Recover a seat to a new bridge key, revoking the previous binding.
    function rotate(uint256 seatId, bytes32 deviceKey) external nonReentrant {
        Seat storage seat = seats[seatId];
        if (seat.owner != msg.sender) revert NotSeatOwner();
        bytes32 previous = seat.deviceKey;
        if (previous == bytes32(0)) revert SeatNotBound();
        if (previous == deviceKey) revert DeviceUnchanged();
        _validateDeviceKey(deviceKey);
        delete seatOfDevice[msg.sender][previous];
        seat.deviceKey = deviceKey;
        ++seat.generation;
        seatOfDevice[msg.sender][deviceKey] = seatId;
        emit SeatRotated(seatId, previous, deviceKey, seat.generation);
    }

    function _validateQuantity(uint256 quantity) private pure {
        if (quantity == 0 || quantity > MAX_BATCH) revert InvalidQuantity();
    }

    function _validateDeviceKey(bytes32 deviceKey) private view {
        if (deviceKey == bytes32(0)) revert InvalidDeviceKey();
        if (seatOfDevice[msg.sender][deviceKey] != 0) revert DeviceAlreadyBound(deviceKey);
    }

    function _collectPayment(uint256 quantity) private {
        uint256 amount = quantity * UNIT_PRICE;
        uint256 beforeBalance = token.balanceOf(treasury);
        token.safeTransferFrom(msg.sender, treasury, amount);
        uint256 afterBalance = token.balanceOf(treasury);
        uint256 received = afterBalance >= beforeBalance ? afterBalance - beforeBalance : 0;
        if (received != amount) revert PaymentAmountMismatch(amount, received);
    }
}
